import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadAgentRules } from '@meebox/agent';
import {
  PRAGENT_LOCAL_OUTPUT,
  PrAgentRunError,
  askLanguageSuffixFor,
  buildExtraInstructions,
  buildToolEnv,
  extraInstructionsEnvKey,
  stripAskQuestionEcho,
  type PrAgentBridge,
} from '@meebox/pr-agent-bridge';
import {
  addFindingClosure,
  dropPendingFindingDrafts,
  finishReviewRun,
  parseReviewOutput,
  startReviewRun,
} from '@meebox/poller';
import { combineRuleInstructions, pickMatchingRules } from '@meebox/rules';
import {
  AppError,
  ERROR_CODES,
  type ReviewRun,
  type ReviewRunStatus,
} from '@meebox/shared';
import { getMainLanguage } from '../../i18n/index.js';
import { resolveActiveLlmProfile } from '../../utils/agent.js';
import { buildPrContext } from '../../utils/pr-context.js';
import { buildProxyEnv } from '../../utils/proxy.js';
import type { ServiceContext } from '../context.js';
import type { QueueItem } from './run-queue.js';
import {
  accumulateUsageSentinel,
  finalizeUsage,
  newUsageAcc,
  stripUsageSentinels,
} from './usage.js';
import { neutralizeWorktreeInstructions } from './worktree-sanitize.js';

/** Finalization patch type for finishReviewRun (return of the finalization helper). */
type FinishPatch = Parameters<typeof finishReviewRun>[3];

/**
 * The **executor** for a pr-agent run (separate from queue scheduling in RunQueue): given an
 * already-dequeued queue item, it runs one run to completion. Scheduling (concurrency / priority /
 * cancel / pump) belongs to RunQueue; this class only handles "how to run one run", with no queue state.
 *
 * execute orchestrates five stages: startRun (persist + mark started) → prepareWorkspace (mirror + worktree)
 * → buildInvocation (env + prompt assembly) → bridge.run (spawn) → collectOutput (read artifacts + parse) → finalize persist.
 */
export class RunExecutor {
  private readonly execFileP = promisify(execFile);
  /** Memo for the embedded .secrets.toml fallback (resolve dir + write file only once, on the first embedded run). */
  private embeddedSecretsEnsured: Promise<void> | null = null;

  constructor(private readonly ctx: ServiceContext) {}

  /**
   * Actually execute one queue item: startRun → worktree → bridge.run → finishWith.
   * Called by RunQueue.pump(); any thrown error is caught by the scheduling layer into a Promise reject,
   * received by the outer pragent:run caller.
   * notifyStarted: once startedAt is settled, calls back into the scheduling layer to broadcast queue
   * changes (the executor holds no queue state).
   */
  async execute(item: QueueItem, notifyStarted: () => void): Promise<ReviewRun> {
    const { getPrAgentBridge, embeddedPythonPath, broadcast } = this.ctx;
    const bridge = getPrAgentBridge();
    if (!bridge) throw new AppError(ERROR_CODES.AG_PR_AGENT_NOT_READY);
    const { req, pr } = item;
    // per-PR storage routing: when re-running review for an already-archived (closed-scope) merged /
    // still-open PR, run data goes to archived cold storage, not the active store (otherwise the next
    // poll reconciliation would wrongly delete it along with archived data, see PrService.storeForPr).
    const stateStore = await this.ctx.pr.storeForPr(pr.localId);

    const run = await this.startRun(item, bridge, notifyStarted);
    const t0 = Date.now();
    // Real token usage accumulator: sitecustomize's litellm callback emits each call's usage as a
    // `@@MEEBOX_USAGE@@ {json}` sentinel line to stderr; onLine below intercepts and accumulates (no temp file / env needed).
    const usageAcc = newUsageAcc();
    const onLine = (line: string, stream: 'stdout' | 'stderr'): void => {
      // Intercept usage sentinel lines: accumulate then don't forward to the renderer (avoid polluting live logs).
      if (stream === 'stderr' && accumulateUsageSentinel(line, usageAcc)) return;
      broadcast('pragent:runProgress', { runId: run.id, line, stream });
    };
    const finishWith = async (patch: Parameters<typeof finishReviewRun>[3]): Promise<ReviewRun> => {
      const updated = await finishReviewRun(stateStore, pr.localId, run.id, patch);
      return updated ?? { ...run, ...patch };
    };

    const wt = await this.prepareWorkspace(pr, req.scope);
    try {
      const { env, extraArgs, askLangSuffix } = await this.buildInvocation(
        req,
        pr,
        run.id,
        wt.path,
      );

      // In CLI mode /ask sets the subprocess cwd to the worktree (for full file context; buildInvocation
      // already set MEEBOX_CLI_WORKDIR). Before landing cwd, clear the repo's own agent instruction files
      // to avoid the CLI auto-loading them and polluting the answer. Presence of the env key gates this path.
      if (env['MEEBOX_CLI_WORKDIR']) {
        await neutralizeWorktreeInstructions(env['MEEBOX_CLI_WORKDIR'], this.ctx.logger);
      }

      // embedded strategy: at execution time write an empty .secrets.toml into the embedded install dir
      // to suppress the startup warning (memoized, done only on the first run).
      // local-cli doesn't need it (pipx-installed pr-agent has a different path and the warning doesn't appear).
      if (bridge.strategy === 'embedded' && embeddedPythonPath) {
        await this.ensureEmbeddedSecrets(embeddedPythonPath);
      }

      const result = await bridge.run({
        prUrl: pr.url,
        tool: req.tool,
        env,
        onLine,
        cwd: wt.path,
        targetBranch: wt.targetBranchName,
        extraArgs,
        signal: item.ac!.signal,
      });
      // Real token usage (stderr sentinel lines accumulated by onLine), carried into succeeded / llm-failed finalization.
      const tokenUsage = finalizeUsage(usageAcc);
      const { parsed, fileContent } = await this.collectOutput(
        wt,
        result.stdout,
        req,
        run.id,
        askLangSuffix,
      );
      return await finishWith(
        this.finishPatchForResult(result, parsed, fileContent, tokenUsage, t0, run.id),
      );
    } catch (err) {
      const tokenUsage = finalizeUsage(usageAcc);
      const finished = await finishWith(
        this.finishPatchForError(err, tokenUsage, t0, run.id),
      );
      // Unexpected exception (not PrAgentRunError): after persisting failed, still rethrow to avoid swallowing it.
      if (!(err instanceof PrAgentRunError)) throw err;
      return finished;
    } finally {
      await wt.cleanup();
    }
  }

  /**
   * Success-path finalization patch: parsed.llmFailure → failed(reason=llm-error), otherwise succeeded.
   * The pr-agent CLI may exit 0 while stdout is actually a total LLM-call failure (litellm AuthenticationError /
   * "Failed to generate prediction with any model" and similar markers) → not counted as succeeded, UI renders a red failure chip.
   * stdout persists the "real LLM output" (file content); the original stdout is kept as a log in a collapsed area for troubleshooting.
   */
  private finishPatchForResult(
    result: { exitCode: number; stdout: string; stderr: string },
    parsed: ReturnType<typeof parseReviewOutput>,
    fileContent: string,
    tokenUsage: ReturnType<typeof finalizeUsage>,
    t0: number,
    runId: string,
  ): FinishPatch {
    const stdout = fileContent
      ? `${fileContent}\n\n---\n[pr-agent stdout log]\n${result.stdout}`
      : result.stdout;
    const base = {
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      exitCode: result.exitCode,
      stdout,
      stderr: stripUsageSentinels(result.stderr),
      tokenUsage,
    };
    if (parsed.llmFailure) {
      this.ctx.logger.warn(
        { runId, reason: parsed.llmFailure.message },
        'pragent exit 0 but LLM call failed; marking run as failed',
      );
      // Failed runs get no structured collection — findings set empty, UI shows only raw output (no chatpane finding card).
      return {
        ...base,
        status: 'failed',
        errorReason: 'llm-error',
        errorMessage: parsed.llmFailure.message,
        findings: [],
      };
    }
    return {
      ...base,
      status: 'succeeded',
      findings: parsed.findings,
      summary: parsed.summary,
      // Re-review verdict (parsed from the re-review /ask's <verdict>); undefined if not a re-review / not given.
      askVerdict: parsed.askVerdict,
    };
  }

  /**
   * Error-path finalization patch: PrAgentRunError → cancelled (user cancel) / failed (other reason), parsing
   * whatever partial stdout was collected + recording token usage already produced; other unexpected exceptions
   * → failed (errorMessage only, to avoid a run stuck in running).
   */
  private finishPatchForError(
    err: unknown,
    tokenUsage: ReturnType<typeof finalizeUsage>,
    t0: number,
    runId: string,
  ): FinishPatch {
    if (err instanceof PrAgentRunError) {
      // User-initiated cancel → cancelled, other reason → failed; both are persisted so the UI can see the event in run history.
      const status: ReviewRunStatus = err.reason === 'cancelled' ? 'cancelled' : 'failed';
      this.ctx.logger.warn(
        { runId, reason: err.reason, exitCode: err.result.exitCode },
        `pragent run ${status}`,
      );
      // Failed / cancelled runs get no structured collection — keep only raw output (stdout/stderr) for display, not parsed into finding cards.
      return {
        status,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        exitCode: err.result.exitCode,
        errorReason: err.reason,
        errorMessage: err.message,
        stdout: err.result.stdout,
        stderr: stripUsageSentinels(err.result.stderr),
        findings: [],
        tokenUsage,
      };
    }
    return {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  /** Stage 1: persist startReviewRun (using the runId pre-assigned at enqueue) + mark startedAt + notify scheduling layer to broadcast + log. */
  private async startRun(
    item: QueueItem,
    bridge: PrAgentBridge,
    notifyStarted: () => void,
  ): Promise<ReviewRun> {
    const { bootstrap, logger } = this.ctx;
    const { req, pr } = item;
    const stateStore = await this.ctx.pr.storeForPr(pr.localId);
    // Resolve the active LLM profile early — the model field must be persisted together with startReviewRun so the
    // UI shows "which model this run used" in the meta row (persist profile.model verbatim, no normalizeModel prefix handling, consistent with Settings).
    const activeLlmForRecord = resolveActiveLlmProfile(bootstrap.config.llm);
    // Override startReviewRun's self-generated id with the runId pre-assigned at enqueue, so cancel(runId) can precisely locate it even in active state.
    const run = await startReviewRun(stateStore, {
      id: item.info.runId,
      prLocalId: pr.localId,
      tool: req.tool,
      question: req.tool === 'ask' ? req.question : undefined,
      prAgentVersion: bridge.version,
      strategy: bridge.strategy,
      model: activeLlmForRecord?.model || undefined,
      // Re-review reference forward chain: persisted with the run, the UI uses it to show a "re-reviewed from…" badge + verdict action on the /ask card.
      referencedFinding: req.tool === 'ask' ? req.referencedFinding : undefined,
      // Trigger origin persisted with the run: user-origin runs get a command echo bubble added by ChatPane; agent sub-runs don't echo.
      origin: item.priority,
      // Single-commit review scope persisted with the run: the result card uses it to show a scope badge.
      scope: req.scope,
    });
    // Upgrade the info (startedAt=null at enqueue) to active form + broadcast (via the scheduling layer).
    item.info = { ...item.info, startedAt: run.startedAt };
    notifyStarted();
    logger.info(
      { runId: run.id, localId: pr.localId, tool: req.tool, strategy: bridge.strategy },
      'pragent run start',
    );
    return run;
  }

  /**
   * Stage 2: sync mirror + materialize worktree (same source as the UI diff; review is based on the PR's forked changes).
   * By default bounds the full PR by a fixed merge-base (head=PR source sha, base=merge-base); when a single-commit scope
   * is passed, bounds by that commit's own changes instead (head=scope.sha, base=scope.parent), so pr-agent sees only the parent..sha diff.
   */
  private async prepareWorkspace(pr: QueueItem['pr'], scope?: QueueItem['req']['scope']) {
    const { repoMirror, pr: prService } = this.ctx;
    const repoId = prService.repoIdentityFor(pr);
    // Use ensureMirrorReadyForPr (rather than bare syncMirror): same source as the UI diff, and reuses its self-healing —
    // after the source branch is deleted / force-pushed, it precisely fetches the PR head ref per platform to fill in the head sha,
    // otherwise materializeWorktree building the head branch would fail on the missing object.
    await prService.ensureMirrorReadyForPr(pr);
    if (scope) {
      // Single-commit scope: head=target commit, base=its parent commit → LOCAL__TARGET_BRANCH points at parent,
      // pr-agent sees only that commit's own changes. parent is an ancestor of head and present via mirror sync, no extra fetch needed.
      return repoMirror.materializeWorktree(repoId, scope.sha, scope.parent, pr.localId);
    }
    // pr-agent's LOCAL__TARGET_BRANCH uses a fixed merge-base, rather than a two-dot comparison that would mix in another PR after targetRef.sha drifts.
    const diffBase = await prService.resolveDiffBaseSha(pr);
    return repoMirror.materializeWorktree(repoId, pr.sourceRef.sha, diffBase, pr.localId);
  }

  /**
   * Stage 3: assemble bridge.run's env + positional args. Proxy env as the base + buildToolEnv (credentials/model/response language/per-tool),
   * then inject EXTRA_INSTRUCTIONS (PR context + matched rules; the local provider won't fetch them itself, must read now; /ask skips this).
   * /ask passes the question as a positional arg and appends the target-language requirement at the end (recency position improves adherence to answering in the UI language).
   */
  private async buildInvocation(
    req: QueueItem['req'],
    pr: QueueItem['pr'],
    runId: string,
    wtPath: string,
  ): Promise<{
    env: Record<string, string>;
    extraArgs: string[] | undefined;
    askLangSuffix: string;
  }> {
    const { bootstrap, logger, ensureAgentDir, pr: prService } = this.ctx;
    const activeLlm = resolveActiveLlmProfile(bootstrap.config.llm);
    // Proxy env as the base first (not pr-agent's domain, just HTTP(S)_PROXY-type); LLM credentials/model + response language + per-tool config
    // are assembled by intent via the bridge's buildToolEnv — contract keys are consolidated in @meebox/pr-agent-bridge.
    const env: Record<string, string> = {
      ...buildProxyEnv(bootstrap.config.proxy),
      ...buildToolEnv(activeLlm, {
        tool: req.tool,
        responseLanguage: getMainLanguage(),
        maxModelTokens: bootstrap.config.llm.context_tokens,
        maxCodeSuggestions: bootstrap.config.agent.strategy.max_code_suggestions,
      }),
    };

    // CLI mode /ask: set the subprocess cwd to the (to-be-sanitized) worktree so free-form Q&A can read full files
    // (shim cli/install.py switches cwd based on this env). describe/review don't set it and keep a neutral temp dir; API mode is unaffected (the remote interface only has the diff).
    if (req.tool === 'ask' && activeLlm?.provider === 'cli') {
      env['MEEBOX_CLI_WORKDIR'] = wtPath;
    }

    let prContext = '';
    let matchedRuleInstructions = '';
    let matchedRuleIds: string[] = [];
    if (req.tool !== 'ask') {
      const adapter = prService.adapterFor(pr);
      if (adapter) {
        try {
          prContext = await buildPrContext({ pr, adapter, logger });
        } catch (err) {
          logger.warn(
            { err, runId, localId: pr.localId },
            'buildPrContext threw; proceeding without PR context',
          );
        }
      }

      const rules = await loadAgentRules(await ensureAgentDir(), {
        onWarn: (msg, file) => logger.warn({ file }, `rules: ${msg}`),
      });
      const matched = pickMatchingRules(rules, {
        projectKey: pr.repo.projectKey,
        repoSlug: pr.repo.repoSlug,
        targetBranch: pr.targetRef.displayId,
        tool: req.tool,
      });
      if (matched.length) {
        matchedRuleInstructions = combineRuleInstructions(matched);
        matchedRuleIds = matched.map((r) => r.id);
      }
      // Always log one line: let users confirm rule loading/matching from logs (output even on 0 matches, to help debug "why the rule didn't take effect").
      logger.info(
        { runId, tool: req.tool, rulesLoaded: rules.length, rulesMatched: matched.length, ruleIds: matchedRuleIds },
        'pragent run: rules',
      );
    }

    // Prompt assembly is consolidated into @meebox/pr-agent-bridge's prompts: language directive / anchor marker / formatting / PR context / matched rules.
    const extraInstructions = buildExtraInstructions({
      tool: req.tool,
      language: getMainLanguage(),
      prContext,
      matchedRuleInstructions,
      // User-defined code-suggestion spec (settings): injected for /improve /review /ask (gated inside buildExtraInstructions); /describe excluded.
      codeSuggestionSpec: bootstrap.config.agent.strategy.code_suggestion_spec,
      // /ask selected-line reference + re-review verdict: spliced into the "question" (user turn), see askQuestion assembly below.
      referencedContext: req.tool === 'ask' ? req.referencedContext : undefined,
      // /ask re-review mode: inject verdict (replace/keep/drop) directive when a finding is referenced.
      referencedFinding: req.tool === 'ask' ? !!req.referencedFinding : undefined,
      // /ask code-suggestion count soft constraint (shares the same setting as /review /improve).
      maxCodeSuggestions:
        req.tool === 'ask' ? bootstrap.config.agent.strategy.max_code_suggestions : undefined,
      // /ask code-retrieval guidance: injected only for the CLI provider (subprocess cwd is in the full worktree, file tools available), steering targeted retrieval
      // (built-in read-only search / grep for symbols · read only the needed line ranges) instead of reading whole files, lowering agentic exploration cost. Deliberately uses only the read-only tool set
      // (in headless default mode non-read-only tools abort the session, so don't induce rg). The API provider has no file access, not injected.
      worktreeRetrieval: req.tool === 'ask' && activeLlm?.provider === 'cli',
    });
    // /ask's pr_questions prompt **does not render extra_instructions** (unlike describe/review/improve),
    // so env injection is a dead field for /ask. Thus /ask's instructions are instead spliced into the "question"
    // (user turn, see askQuestion below); env injection is only used for the other three tools.
    if (extraInstructions && req.tool !== 'ask') {
      env[extraInstructionsEnvKey(req.tool)] = extraInstructions;
    }
    if (prContext) {
      logger.debug(
        { runId, tool: req.tool, contextChars: prContext.length },
        'pragent run: pr context injected',
      );
    }

    // ask tool: the question is a positional arg (user turn, a single spawn-args element; spaces don't split it into multiple args),
    // and the language requirement is hard-appended at the **end** of the question. System-side CONFIG__RESPONSE_LANGUAGE / EXTRA_INSTRUCTIONS
    // for free-form Q&A are often drowned out by the large English diff → the model answers in English; ask again at the end of the user turn (recency position, written in the target language). en-US returns empty.
    const askLangSuffix = req.tool === 'ask' ? askLanguageSuffixFor(getMainLanguage()) : '';
    let askQuestion: string | undefined;
    if (req.tool === 'ask' && req.question) {
      // /ask's instructions (structured sections / anchor marker / re-review verdict / referenced context) are spliced into the user turn —
      // pr_questions doesn't read extra_instructions, only the question text actually reaches the model. The language suffix goes last (recency position most encourages answering in the target language).
      // The echo (pr-agent writes the question verbatim into the artifact) is stripped entirely by collectOutput's stripAskQuestionEcho.
      const parts = [req.question];
      if (extraInstructions) parts.push(extraInstructions);
      if (askLangSuffix) parts.push(askLangSuffix);
      askQuestion = parts.join('\n\n');
    }
    const extraArgs = askQuestion ? [askQuestion] : undefined;
    return { env, extraArgs, askLangSuffix };
  }

  /**
   * Stage 5: read the artifact file the local provider wrote to the worktree root (persisted filename see PRAGENT_LOCAL_OUTPUT), /ask removes
   * the echoed question line, parse into findings/summary; on /review success drop old pending drafts (letting this round's findings become the new candidate source).
   * If the file is missing, fall back to parsing stdout. Returns the parse result + raw file content (for finalization log splicing).
   */
  private async collectOutput(
    wt: { path: string },
    resultStdout: string,
    req: QueueItem['req'],
    runId: string,
    askLangSuffix: string,
  ): Promise<{ parsed: ReturnType<typeof parseReviewOutput>; fileContent: string }> {
    const { logger, broadcast } = this.ctx;
    const stateStore = await this.ctx.pr.storeForPr(req.localId);
    // The file must be read out before cleanup (same source as buildToolEnv's LOCAL__REVIEW_PATH).
    const outFile = PRAGENT_LOCAL_OUTPUT[req.tool];
    let fileContent = '';
    try {
      fileContent = await fs.readFile(path.join(wt.path, outFile), 'utf8');
    } catch (readErr) {
      logger.warn(
        { err: readErr, wtPath: wt.path, outFile, runId },
        'pr-agent local provider output file missing; fall back to stdout',
      );
    }
    // In /ask output pr-agent echoes the question verbatim at the top of the answer body (duplicating the chat input bubble); delete it verbatim before parsing.
    const cleanedContent =
      req.tool === 'ask' && req.question?.trim()
        ? stripAskQuestionEcho(fileContent, req.question, askLangSuffix)
        : fileContent;
    const parsed = parseReviewOutput(cleanedContent || resultStdout, req.tool);
    // Re-review /ask (a finding was referenced):
    // - verdict replace → promote the suggestion to a positioned code comment (taking the original finding's anchor), rendered / adopted like /review code feedback;
    // - verdict replace / drop → silently close the referenced original finding (establish the closure relation + broadcast), no need for the user to manually click close.
    // keep / no verdict: the original comment is kept, untouched.
    if (req.tool === 'ask' && req.referencedFinding && parsed.askVerdict && !parsed.llmFailure) {
      const ref = req.referencedFinding;
      const anchor = ref.anchor;
      if (parsed.askVerdict === 'replace' && anchor && typeof anchor.startLine === 'number') {
        // A code-suggestion that already carries positioning (the model anchored to the reference via the marker) is left untouched; otherwise the suggestion (fallen back to summary)
        // is fallback-anchored to the referenced comment's original position and promoted to code feedback, ensuring the replacing comment always carries positioning and is adoptable.
        const sug =
          parsed.findings.find(
            (f) => f.sectionKey === 'code-suggestion' || f.sectionKey === 'ask-suggestions',
          ) ?? parsed.findings.find((f) => f.sectionKey === 'ask-summary');
        if (sug && !sug.anchor) {
          sug.anchor = { ...anchor };
          sug.sectionKey = 'code-feedback';
          sug.category = 'code-feedback';
        }
      }
      if (parsed.askVerdict === 'replace' || parsed.askVerdict === 'drop') {
        try {
          await addFindingClosure(stateStore, req.localId, {
            runId: ref.runId,
            findingId: ref.findingId,
            byAskRunId: runId,
            verdict: parsed.askVerdict,
          });
          broadcast('findingClosures:changed', { localId: req.localId });
        } catch (err) {
          logger.warn({ err, runId }, 'auto-close referenced finding on /ask verdict failed');
        }
      }
    }
    // M4 draft re-ingestion: on successful /review completion drop old pending+finding drafts (edited/posted/rejected/manual are kept).
    if (req.tool === 'review') {
      try {
        const dropped = await dropPendingFindingDrafts(stateStore, req.localId);
        if (dropped > 0) {
          logger.info(
            { runId, localId: req.localId, dropped },
            'pragent /review: dropped stale pending drafts',
          );
          broadcast('drafts:changed', { localId: req.localId });
        }
      } catch (err) {
        logger.warn({ err, runId }, 'dropPendingFindingDrafts failed');
      }
    }
    return { parsed, fileContent };
  }

  /**
   * embedded strategy: at execution time write an empty .secrets.toml into the embedded install dir's settings/ and settings_prod/
   * (pr-agent looks for this file at startup and prints a WARNING when missing; we pass secrets via env and don't use secrets.toml, so write an empty
   * file to suppress the warning). Memoized: resolve dir + write file only once on the first embedded run, reused afterwards.
   * importlib.util.find_spec only locates pr_agent without importing it, fast; on failure only warn, don't block the run.
   */
  private ensureEmbeddedSecrets(pythonPath: string): Promise<void> {
    this.embeddedSecretsEnsured ??= (async () => {
      const { stdout } = await this.execFileP(pythonPath, [
        '-c',
        "import importlib.util,os;print(os.path.dirname(importlib.util.find_spec('pr_agent').origin))",
      ]);
      const prAgentDir = stdout.trim();
      for (const sub of ['settings', 'settings_prod']) {
        const dir = path.join(prAgentDir, sub);
        await fs.mkdir(dir, { recursive: true });
        const f = path.join(dir, '.secrets.toml');
        try {
          await fs.access(f);
        } catch {
          await fs.writeFile(
            f,
            '# meebox placeholder: silence pr-agent warning about a missing .secrets.toml\n',
          );
        }
      }
    })().catch((err: unknown) => {
      this.ctx.logger.warn({ err }, 'ensure embedded .secrets.toml failed (ignored)');
    });
    return this.embeddedSecretsEnsured;
  }
}
