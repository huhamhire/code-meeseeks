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
    const { getPrAgentBridge, embeddedPythonPath, broadcast } = this.ctx;
    const bridge = getPrAgentBridge();
    if (!bridge) throw new AppError(ERROR_CODES.AG_PR_AGENT_NOT_READY);
    const { req, pr } = item;
    // per-PR 存储路由：对已归档（已关闭范围）的合并 / 仍开放 PR 补跑评审时，run 数据落归档冷存储，
    // 不写活跃存储（否则被下轮 poll 对账连同归档数据误删，见 PrService.storeForPr）。
    const stateStore = await this.ctx.pr.storeForPr(pr.localId);

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

    const wt = await this.prepareWorkspace(pr, req.scope);
    try {
      const { env, extraArgs, askLangSuffix } = await this.buildInvocation(
        req,
        pr,
        run.id,
        wt.path,
      );

      // CLI 模式 /ask 把子进程 cwd 落到 worktree（取完整文件上下文，buildInvocation 已设 MEEBOX_CLI_WORKDIR）。
      // 落 cwd 前先清空仓库自带的 agent 指令文件，避免被 CLI 自动加载污染回答。env key 在 = 走此路径。
      if (env['MEEBOX_CLI_WORKDIR']) {
        await neutralizeWorktreeInstructions(env['MEEBOX_CLI_WORKDIR'], this.ctx.logger);
      }

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
      tokenUsage,
    };
    if (parsed.llmFailure) {
      this.ctx.logger.warn(
        { runId, reason: parsed.llmFailure.message },
        'pragent exit 0 but LLM call failed; marking run as failed',
      );
      // 失败任务不做结构化采集——findings 置空，UI 只展示原始输出（不转 chatpane finding 卡）。
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
      // 复评裁决（解析自复评 /ask 的 <verdict>）；非复评 / 未给则 undefined。
      askVerdict: parsed.askVerdict,
    };
  }

  /**
   * 异常路径收尾 patch：PrAgentRunError → cancelled（用户取消）/ failed（其它 reason），尽量解析已收集的
   * 部分 stdout + 记已产生的 token 用量；其它非预期异常 → failed（仅 errorMessage，避免 run 卡在 running）。
   */
  private finishPatchForError(
    err: unknown,
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
      // 失败 / 取消的任务不做结构化采集——只保留原始输出（stdout/stderr）供展示，不解析成 finding 卡。
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

  /** 阶段①：落盘 startReviewRun（用入队预分配 runId）+ 标记 startedAt 并通知调度层广播 + 记日志。 */
  private async startRun(
    item: QueueItem,
    bridge: PrAgentBridge,
    notifyStarted: () => void,
  ): Promise<ReviewRun> {
    const { bootstrap, logger } = this.ctx;
    const { req, pr } = item;
    const stateStore = await this.ctx.pr.storeForPr(pr.localId);
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
      // 复评引用前向链：随 run 落盘，UI 据此在 /ask 卡上展示「复评自…」徽标 + 裁决动作。
      referencedFinding: req.tool === 'ask' ? req.referencedFinding : undefined,
      // 触发来源随 run 落盘：user 来源的 run 由 ChatPane 补命令回显气泡；agent 子 run 不回显。
      origin: item.priority,
      // 单 commit 评审范围随 run 落盘：结果卡据此展示范围徽标。
      scope: req.scope,
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

  /**
   * 阶段②：同步镜像 + 物化 worktree（与 UI diff 同源，评审基于 PR 自分叉的改动）。
   * 缺省按固定 merge-base 定界 PR 全量（head=PR 源 sha，base=merge-base）；传入单 commit 范围（scope）时
   * 改按该 commit 自身改动定界（head=scope.sha，base=scope.parent），pr-agent 只见 parent..sha 的 diff。
   */
  private async prepareWorkspace(pr: QueueItem['pr'], scope?: QueueItem['req']['scope']) {
    const { repoMirror, pr: prService } = this.ctx;
    const repoId = prService.repoIdentityFor(pr);
    // 走 ensureMirrorReadyForPr（而非裸 syncMirror）：与 UI diff 同源，且复用其自愈——源分支被删 / 强推后
    // 按平台精确 fetch PR 头引用补齐 head sha，否则 materializeWorktree 建 meebox/head 会因对象缺失失败。
    await prService.ensureMirrorReadyForPr(pr);
    if (scope) {
      // 单 commit 范围：head=目标 commit，base=其父 commit → LOCAL__TARGET_BRANCH 指向 parent，
      // pr-agent 只见该 commit 自身改动。parent 是 head 的祖先、随镜像同步而在，无需另取。
      return repoMirror.materializeWorktree(repoId, scope.sha, scope.parent);
    }
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
    wtPath: string,
  ): Promise<{
    env: Record<string, string>;
    extraArgs: string[] | undefined;
    askLangSuffix: string;
  }> {
    const { bootstrap, logger, ensureAgentDir, pr: prService } = this.ctx;
    const activeLlm = resolveActiveLlmProfile(bootstrap.config.llm);
    // 代理 env 先铺底（非 pr-agent 范畴，仅 HTTP(S)_PROXY 类）；LLM 凭据/模型 + 响应语言 + per-tool 配置
    // 由 bridge 的 buildToolEnv 按意图组装——契约 key 收口在 @meebox/pr-agent-bridge。
    const env: Record<string, string> = {
      ...buildProxyEnv(bootstrap.config.proxy),
      ...buildToolEnv(activeLlm, {
        tool: req.tool,
        responseLanguage: getMainLanguage(),
        maxModelTokens: bootstrap.config.llm.context_tokens,
        maxCodeSuggestions: bootstrap.config.agent.strategy.max_code_suggestions,
      }),
    };

    // CLI 模式 /ask：把子进程 cwd 落到（待净化的）worktree，让自由问答能读完整文件（shim cli/install.py
    // 据此 env 切 cwd）。describe/review 不下发、维持中性临时目录；API 模式不涉及（远程接口只有 diff）。
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
      // 始终记一条：让用户从日志确认规则加载/命中情况（0 命中也输出，便于排查「为何规则没生效」）。
      logger.info(
        { runId, tool: req.tool, rulesLoaded: rules.length, rulesMatched: matched.length, ruleIds: matchedRuleIds },
        'pragent run: rules',
      );
    }

    // 提示词组装收口到 @meebox/pr-agent-bridge 的 prompts：语言指示 / anchor marker / 排版 / PR 上下文 / 命中规则。
    const extraInstructions = buildExtraInstructions({
      tool: req.tool,
      language: getMainLanguage(),
      prContext,
      matchedRuleInstructions,
      // /ask 选中行引用 + 复评裁决：拼进「问题」（user turn），见下方 askQuestion 组装。
      referencedContext: req.tool === 'ask' ? req.referencedContext : undefined,
      // /ask 复评模式：引用了某条 finding 时注入裁决（replace/keep/drop）指示。
      referencedFinding: req.tool === 'ask' ? !!req.referencedFinding : undefined,
      // /ask 代码建议数量软约束（与 /review /improve 共用同一设置）。
      maxCodeSuggestions:
        req.tool === 'ask' ? bootstrap.config.agent.strategy.max_code_suggestions : undefined,
    });
    // /ask 的 pr_questions prompt **不渲染 extra_instructions**（与 describe/review/improve 不同），
    // 经 env 注入对 /ask 是死字段。故 /ask 的指令改为拼进「问题」（user turn，见下方 askQuestion），
    // env 注入仅用于其它三个工具。
    if (extraInstructions && req.tool !== 'ask') {
      env[extraInstructionsEnvKey(req.tool)] = extraInstructions;
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
    let askQuestion: string | undefined;
    if (req.tool === 'ask' && req.question) {
      // /ask 的指令（结构化分段 / anchor marker / 复评裁决 / 引用上下文）拼进 user turn——pr_questions
      // 不读 extra_instructions，唯有问题文本真正到达模型。语言后缀放最末（近因位置最促使按目标语言作答）。
      // 回显（pr-agent 把问题原样写进产物）由 collectOutput 的 stripAskQuestionEcho 整段剥掉。
      const parts = [req.question];
      if (extraInstructions) parts.push(extraInstructions);
      if (askLangSuffix) parts.push(askLangSuffix);
      askQuestion = parts.join('\n\n');
    }
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
    const { logger, broadcast } = this.ctx;
    const stateStore = await this.ctx.pr.storeForPr(req.localId);
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
    // 复评 /ask（引用了某条 finding）：
    // - 裁决 replace → 把建议提升为带定位的代码评论（取原 finding 的 anchor），渲染 / 采纳同 /review 代码反馈；
    // - 裁决 replace / drop → 静默关闭被引用的原 finding（建立关闭关系 + 广播），无需用户手动点关闭。
    // keep / 无裁决：原评论保留、不动。
    if (req.tool === 'ask' && req.referencedFinding && parsed.askVerdict && !parsed.llmFailure) {
      const ref = req.referencedFinding;
      const anchor = ref.anchor;
      if (parsed.askVerdict === 'replace' && anchor && typeof anchor.startLine === 'number') {
        // 已自带定位的 code-suggestion（模型按 marker 锚到引用处）保持不动；否则把建议（退到 summary）
        // 兜底锚到被引用评论的原位置并升为代码反馈，保证取代评论始终带定位、可采纳。
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
