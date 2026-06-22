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
  dropPendingFindingDrafts,
  finishReviewRun,
  parseReviewOutput,
  startReviewRun,
} from '@meebox/poller';
import { pickMatchingRule } from '@meebox/rules';
import {
  AppError,
  ERROR_CODES,
  type ReviewRun,
  type ReviewRunStatus,
  type ReviewRunTool,
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

/** finishReviewRun 的收尾 patch 类型（收尾 helper 的返回）。 */
type FinishPatch = Parameters<typeof finishReviewRun>[3];

/**
 * pr-agent run 的**执行器**（与队列调度 RunQueue 分离）：给定一个已 dequeue 的队列项，跑完一个 run。
 * 调度（并发 / 优先级 / 取消 / 泵）归 RunQueue；本类只管「怎么跑一个 run」，无队列状态。
 *
 * execute 编排五个阶段：startRun（落盘 + 标记开始）→ prepareWorkspace（镜像 + worktree）→
 * buildInvocation（env + 提示词组装）→ bridge.run（spawn）→ collectOutput（读产物 + 解析）→ 收尾落盘。
 */
export class RunExecutor {
  private readonly execFileP = promisify(execFile);
  /** embedded .secrets.toml 兜底的 memo（只在首个 embedded run 解析一次目录 + 写文件）。 */
  private embeddedSecretsEnsured: Promise<void> | null = null;

  constructor(private readonly ctx: ServiceContext) {}

  /**
   * 真正执行一个 queue item：startRun → worktree → bridge.run → finishWith。
   * 由 RunQueue.pump() 调用；任何抛错都被调度层兜成 Promise reject，外层 pragent:run 调用方收到。
   * notifyStarted：startedAt 落定后回调调度层广播队列变化（执行器不持队列态）。
   */
  async execute(item: QueueItem, notifyStarted: () => void): Promise<ReviewRun> {
    const { getPrAgentBridge, embeddedPythonPath, stateStore, broadcast } = this.ctx;
    const bridge = getPrAgentBridge();
    if (!bridge) throw new AppError(ERROR_CODES.AG_PR_AGENT_NOT_READY);
    const { req, pr } = item;

    const run = await this.startRun(item, bridge, notifyStarted);
    const t0 = Date.now();
    // 真实 token 用量累加器：sitecustomize 的 litellm callback 把每次调用的 usage 以
    // `@@MEEBOX_USAGE@@ {json}` 哨兵行打到 stderr，下面 onLine 拦截累加（无需临时文件 / env）。
    const usageAcc = newUsageAcc();
    const onLine = (line: string, stream: 'stdout' | 'stderr'): void => {
      // 拦截 usage 哨兵行：累加后不转发给 renderer（避免污染实时日志）。
      if (stream === 'stderr' && accumulateUsageSentinel(line, usageAcc)) return;
      broadcast('pragent:runProgress', { runId: run.id, line, stream });
    };
    const finishWith = async (patch: Parameters<typeof finishReviewRun>[3]): Promise<ReviewRun> => {
      const updated = await finishReviewRun(stateStore, pr.localId, run.id, patch);
      return updated ?? { ...run, ...patch };
    };

    const wt = await this.prepareWorkspace(pr);
    try {
      const { env, extraArgs, askLangSuffix } = await this.buildInvocation(req, pr, run.id);

      // embedded 策略：执行期在嵌入式安装目录补空 .secrets.toml 压掉启动告警（memo 化只首次做）。
      // local-cli 不需要（pipx 装的 pr-agent 路径不同，告警也不出）。
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
      // 真实 token 用量（onLine 累加的 stderr 哨兵行），落到 succeeded / llm-failed 收尾。
      const tokenUsage = finalizeUsage(usageAcc);
      const { parsed, fileContent } = await this.collectOutput(wt, result.stdout, req, run.id, askLangSuffix);
      return await finishWith(
        this.finishPatchForResult(result, parsed, fileContent, tokenUsage, t0, run.id),
      );
    } catch (err) {
      const tokenUsage = finalizeUsage(usageAcc);
      const finished = await finishWith(
        this.finishPatchForError(err, req.tool, tokenUsage, t0, run.id),
      );
      // 非预期异常（非 PrAgentRunError）：落 failed 后仍把异常往上抛，避免吞掉。
      if (!(err instanceof PrAgentRunError)) throw err;
      return finished;
    } finally {
      await wt.cleanup();
    }
  }

  /**
   * 成功路径收尾 patch：parsed.llmFailure → failed(reason=llm-error)，否则 succeeded。
   * pr-agent CLI 可能 exit 0 但 stdout 其实是 LLM 调用全失败（litellm AuthenticationError /
   * "Failed to generate prediction with any model" 等 marker）→ 不算 succeeded，UI 用红色失败 chip 渲染。
   * stdout 持久化「LLM 真实产出」(文件内容)；原 stdout 留作日志在折叠区供排障。
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
      findings: parsed.findings,
      summary: parsed.summary,
      tokenUsage,
    };
    if (parsed.llmFailure) {
      this.ctx.logger.warn(
        { runId, reason: parsed.llmFailure.message },
        'pragent exit 0 but LLM call failed; marking run as failed',
      );
      return {
        ...base,
        status: 'failed',
        errorReason: 'llm-error',
        errorMessage: parsed.llmFailure.message,
      };
    }
    return { ...base, status: 'succeeded' };
  }

  /**
   * 异常路径收尾 patch：PrAgentRunError → cancelled（用户取消）/ failed（其它 reason），尽量解析已收集的
   * 部分 stdout + 记已产生的 token 用量；其它非预期异常 → failed（仅 errorMessage，避免 run 卡在 running）。
   */
  private finishPatchForError(
    err: unknown,
    tool: ReviewRunTool,
    tokenUsage: ReturnType<typeof finalizeUsage>,
    t0: number,
    runId: string,
  ): FinishPatch {
    if (err instanceof PrAgentRunError) {
      // 用户主动取消 → cancelled，其它 reason → failed；二者都落盘让 UI 能从历史 run 里看到该事件。
      const status: ReviewRunStatus = err.reason === 'cancelled' ? 'cancelled' : 'failed';
      this.ctx.logger.warn(
        { runId, reason: err.reason, exitCode: err.result.exitCode },
        `pragent run ${status}`,
      );
      // 失败 / 取消时也尽量解析已收集的 stdout（很多情况 pr-agent 已写了一部分输出）。
      const partialStdout = err.result.stdout ?? '';
      const parsed = partialStdout
        ? parseReviewOutput(partialStdout, tool)
        : { findings: [], summary: undefined };
      return {
        status,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        exitCode: err.result.exitCode,
        errorReason: err.reason,
        errorMessage: err.message,
        stdout: err.result.stdout,
        stderr: stripUsageSentinels(err.result.stderr),
        findings: parsed.findings,
        summary: parsed.summary,
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

  /** 阶段①：落盘 startReviewRun（用入队预分配 runId）+ 标记 startedAt 并通知调度层广播 + 记日志。 */
  private async startRun(
    item: QueueItem,
    bridge: PrAgentBridge,
    notifyStarted: () => void,
  ): Promise<ReviewRun> {
    const { bootstrap, logger, stateStore } = this.ctx;
    const { req, pr } = item;
    // 提前 resolve active LLM profile — model 字段要随 startReviewRun 一起落盘，让 UI 在 meta 行展示
    // "这次 run 用的什么模型"（持久化用 profile.model 原文，不做 normalizeModel 前缀处理，跟 Settings 一致）。
    const activeLlmForRecord = resolveActiveLlmProfile(bootstrap.config.llm);
    // 用入队预分配的 runId 覆盖 startReviewRun 的自生 id，让 cancel(runId) 在 active 状态也能精确定位。
    const run = await startReviewRun(stateStore, {
      id: item.info.runId,
      prLocalId: pr.localId,
      tool: req.tool,
      question: req.tool === 'ask' ? req.question : undefined,
      prAgentVersion: bridge.version,
      strategy: bridge.strategy,
      model: activeLlmForRecord?.model || undefined,
    });
    // 把入队时 startedAt=null 的 info 升级为 active 形态 + 广播（经调度层）。
    item.info = { ...item.info, startedAt: run.startedAt };
    notifyStarted();
    logger.info(
      { runId: run.id, localId: pr.localId, tool: req.tool, strategy: bridge.strategy },
      'pragent run start',
    );
    return run;
  }

  /** 阶段②：同步镜像 + 按固定 merge-base 物化 worktree（与 UI diff 同源，评审基于 PR 自分叉的改动）。 */
  private async prepareWorkspace(pr: QueueItem['pr']) {
    const { repoMirror, pr: prService } = this.ctx;
    const repoId = prService.repoIdentityFor(pr);
    await repoMirror.syncMirror(repoId);
    // pr-agent 的 LOCAL__TARGET_BRANCH 用固定 merge-base，而非 targetRef.sha 漂移后混入别的 PR 的两点对比。
    const diffBase = await prService.resolveDiffBaseSha(pr);
    return repoMirror.materializeWorktree(repoId, pr.sourceRef.sha, diffBase);
  }

  /**
   * 阶段③：组装 bridge.run 的 env + 位置参数。代理 env 铺底 + buildToolEnv（凭据/模型/响应语言/per-tool），
   * 再注入 EXTRA_INSTRUCTIONS（PR 上下文 + 命中规则，local provider 不会自己拉，须现读；/ask 跳过）。
   * /ask 把问题作位置参数并在末尾追加目标语言要求（近因位置提升按 UI 语言作答的遵循度）。
   */
  private async buildInvocation(
    req: QueueItem['req'],
    pr: QueueItem['pr'],
    runId: string,
  ): Promise<{ env: Record<string, string>; extraArgs: string[] | undefined; askLangSuffix: string }> {
    const { bootstrap, logger, effectiveAgentDir, pr: prService } = this.ctx;
    const activeLlm = resolveActiveLlmProfile(bootstrap.config.llm);
    // 代理 env 先铺底（非 pr-agent 范畴，仅 HTTP(S)_PROXY 类）；LLM 凭据/模型 + 响应语言 + per-tool 配置
    // 由 bridge 的 buildToolEnv 按意图组装——契约 key 收口在 @meebox/pr-agent-bridge。
    const env: Record<string, string> = {
      ...buildProxyEnv(bootstrap.config.proxy),
      ...buildToolEnv(activeLlm, { tool: req.tool, responseLanguage: getMainLanguage() }),
    };

    let prContext = '';
    let matchedRuleInstructions = '';
    let matchedRuleId: string | undefined;
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

      const rules = await loadAgentRules(effectiveAgentDir(), {
        onWarn: (msg, file) => logger.warn({ file }, `rules: ${msg}`),
      });
      const matched = pickMatchingRule(rules, {
        projectKey: pr.repo.projectKey,
        repoSlug: pr.repo.repoSlug,
        targetBranch: pr.targetRef.displayId,
        tool: req.tool,
      });
      if (matched) {
        matchedRuleInstructions = matched.instructions;
        matchedRuleId = matched.id;
      }
    }

    // 提示词组装收口到 @meebox/pr-agent-bridge 的 prompts：语言指示 / anchor marker / 排版 / PR 上下文 / 命中规则。
    const extraInstructions = buildExtraInstructions({
      tool: req.tool,
      language: getMainLanguage(),
      prContext,
      matchedRuleInstructions,
      // /ask 选中行引用：经 EXTRA_INSTRUCTIONS 注入（不进问题位置参数，故不污染回答 echo）。
      referencedContext: req.tool === 'ask' ? req.referencedContext : undefined,
    });
    if (extraInstructions) env[extraInstructionsEnvKey(req.tool)] = extraInstructions;
    if (matchedRuleId) {
      logger.info({ runId, ruleId: matchedRuleId, tool: req.tool }, 'pragent run: matched rule');
    }
    if (prContext) {
      logger.debug(
        { runId, tool: req.tool, contextChars: prContext.length },
        'pragent run: pr context injected',
      );
    }

    // ask 工具：问题作为位置参数（user turn，spawn args 单元素，含空格也是一个 arg 不切分），并在问题
    // **末尾**硬性追加语言要求。系统侧 CONFIG__RESPONSE_LANGUAGE / EXTRA_INSTRUCTIONS 对自由问答常被大量
    // 英文 diff 盖过 → 模型用英文作答；在 user turn 末尾（近因位置、用目标语言书写）再要求一次。en-US 返回空。
    const askLangSuffix = req.tool === 'ask' ? askLanguageSuffixFor(getMainLanguage()) : '';
    const askQuestion =
      req.tool === 'ask' && req.question
        ? askLangSuffix
          ? `${req.question}\n\n${askLangSuffix}`
          : req.question
        : undefined;
    const extraArgs = askQuestion ? [askQuestion] : undefined;
    return { env, extraArgs, askLangSuffix };
  }

  /**
   * 阶段⑤：读 local provider 写到 worktree 根的产物文件（落盘文件名见 PRAGENT_LOCAL_OUTPUT），/ask 去掉
   * 回显的问题行，解析为 findings/summary；/review 成功时丢弃旧 pending 草稿（让本轮 finding 成新候选源）。
   * 文件缺失则回退用 stdout 解析。返回解析结果 + 原始文件内容（供收尾拼日志）。
   */
  private async collectOutput(
    wt: { path: string },
    resultStdout: string,
    req: QueueItem['req'],
    runId: string,
    askLangSuffix: string,
  ): Promise<{ parsed: ReturnType<typeof parseReviewOutput>; fileContent: string }> {
    const { logger, stateStore, broadcast } = this.ctx;
    // cleanup 前必须先把文件读出来（与 buildToolEnv 的 LOCAL__REVIEW_PATH 同源）。
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
    // /ask 输出里 pr-agent 把问题原样回显在 answer body 顶部（跟 chat 输入气泡重复）；解析前逐字删掉。
    const cleanedContent =
      req.tool === 'ask' && req.question?.trim()
        ? stripAskQuestionEcho(fileContent, req.question, askLangSuffix)
        : fileContent;
    const parsed = parseReviewOutput(cleanedContent || resultStdout, req.tool);
    // M4 草稿再摄入：/review 成功完成时丢掉 pending+finding 旧草稿（edited/posted/rejected/manual 保留）。
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
   * embedded 策略：执行期在嵌入式安装目录的 settings/ 与 settings_prod/ 补空 .secrets.toml
   * （pr-agent 启动会去找该文件，缺失就打 WARNING；我们走 env 传密钥不用 secrets.toml，写个空
   * 文件压掉告警）。memo 化：只在首个 embedded run 解析一次目录 + 写文件，后续直接复用。
   * importlib.util.find_spec 仅定位不 import pr_agent，快；失败仅 warn 不阻断 run。
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
