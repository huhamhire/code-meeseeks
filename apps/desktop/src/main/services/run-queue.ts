import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadAgentRules } from '@meebox/agent';
import type { PragentRunInfo } from '@meebox/ipc';
import {
  PrAgentRunError,
  askLanguageSuffixFor,
  buildExtraInstructions,
  buildPragentEnv,
  extraInstructionsEnvKey,
  stripAskQuestionEcho,
} from '@meebox/pr-agent-bridge';
import {
  dropPendingFindingDrafts,
  finishReviewRun,
  makeRunId,
  parseReviewOutput,
  startReviewRun,
} from '@meebox/poller';
import { pickMatchingRule } from '@meebox/rules';
import type {
  ReviewRun,
  ReviewRunStatus,
  ReviewRunTool,
  StoredPullRequest,
} from '@meebox/shared';
import { getMainLanguage, t } from '../i18n/index.js';
import { resolveActiveLlmProfile } from '../utils/agent.js';
import { buildPrContext } from '../utils/pr-context.js';
import { buildProxyEnv } from '../utils/proxy.js';
import type { ServiceContext } from './context.js';
import {
  accumulateUsageSentinel,
  finalizeUsage,
  newUsageAcc,
  stripUsageSentinels,
} from './usage.js';

/** pr-agent run 优先级泳道：user（手动发起，高）/ agent（编排 / AutoPilot 派发，低）。 */
export type RunPriority = 'user' | 'agent';

/** 队列项：一次入队的 pr-agent run 的全部上下文（含 resolve/reject 回原始调用方）。 */
interface QueueItem {
  info: PragentRunInfo;
  req: { localId: string; tool: ReviewRunTool; question?: string; referencedContext?: string };
  pr: StoredPullRequest;
  resolve: (run: ReviewRun) => void;
  reject: (err: Error) => void;
  /** 优先级泳道：user（手动发起，高）/ agent（编排 / AutoPilot 派发，低）。 */
  priority: RunPriority;
  /** 仅 active 状态填；用于 cancel SIGKILL */
  ac?: AbortController;
}

/**
 * pr-agent run 队列服务。
 *
 * FIFO 队列，并发上限 maxConcurrency（post-Docker 下每个 run 独立 worktree + 独立子进程，
 * 并发安全）。其余在 waiting 排队；每次 active 完成 / 取消 → 自动泵下一条。
 *
 * 设计要点：
 *   - runId 在入队时就分配（跟最终落盘 ReviewRun.id 一致），cancel(runId) 在 active / waiting
 *     两种状态都能精确定位
 *   - queued 状态不落盘；被取消时直接 reject 原 Promise，不留 disk artifact
 *   - 真正 dequeue 才 startReviewRun 写 disk + 跑 pr-agent
 *   - 每次队列变化广播 'pragent:queueChanged'，renderer store 同步
 *
 * 队列与运行态（waiting / active / 并发上限）是实例可变状态，故以 class 封装；PR 领域操作
 * （镜像 / diff base / adapter）经注入的 ctx.pr 取用。
 */
export class RunQueueService {
  private readonly waiting: QueueItem[] = [];
  /** 并发运行中的 run（runId → item）；上限 maxConcurrency。 */
  private readonly active = new Map<string, QueueItem>();
  private readonly maxConcurrency: number;
  private readonly execFileP = promisify(execFile);
  /** embedded .secrets.toml 兜底的 memo（只在首个 embedded run 解析一次目录 + 写文件）。 */
  private embeddedSecretsEnsured: Promise<void> | null = null;

  constructor(private readonly ctx: ServiceContext) {
    this.maxConcurrency = ctx.bootstrap.config.pr_agent.max_concurrency;
  }

  /**
   * 入队一个 pr-agent run（与用户手动 run 共用同一队列 / 并发 / 取消机制）。dedup：同 PR
   * 同工具已在执行 / 排队则抛错（/ask 不限）。resolve 完成的 ReviewRun。
   */
  enqueuePragentRun(
    pr: StoredPullRequest,
    tool: ReviewRunTool,
    question?: string,
    priority: RunPriority = 'user',
    referencedContext?: string,
  ): Promise<ReviewRun> {
    const { logger } = this.ctx;
    if (tool !== 'ask') {
      const sameTask = (q: QueueItem): boolean =>
        q.info.prLocalId === pr.localId && q.info.tool === tool;
      if ([...this.active.values()].some(sameTask) || this.waiting.some(sameTask)) {
        throw new Error(t('prAgent.duplicateTask', { tool }));
      }
    }
    // 入队时就分配 runId；后续 cancel(runId) 在 waiting / active 都能定位
    const runId = makeRunId(new Date());
    return new Promise<ReviewRun>((resolve, reject) => {
      const item: QueueItem = {
        info: {
          runId,
          prLocalId: pr.localId,
          repoSlug: pr.repo.repoSlug,
          prNumber: pr.remoteId,
          tool,
          question: tool === 'ask' ? question : undefined,
          enqueuedAt: new Date().toISOString(),
          startedAt: null,
        },
        // referencedContext 仅入 req（内存态，不进 info/PragentRunInfo）→ 不落盘、不进队列广播。
        req: { localId: pr.localId, tool, question, referencedContext: tool === 'ask' ? referencedContext : undefined },
        pr,
        priority,
        resolve,
        reject,
      };
      // 优先级插队：user 任务排到所有 agent 任务之前（同泳道内仍 FIFO）；不打断在跑的 run。
      if (priority === 'user') {
        const firstAgentIdx = this.waiting.findIndex((q) => q.priority === 'agent');
        if (firstAgentIdx >= 0) this.waiting.splice(firstAgentIdx, 0, item);
        else this.waiting.push(item);
      } else {
        this.waiting.push(item);
      }
      logger.info(
        { runId, localId: pr.localId, tool, priority, queueLen: this.waiting.length },
        'pragent run enqueued',
      );
      this.pump();
    });
  }

  /** 取消一个 run（pragent:cancel）：active→SIGKILL；waiting→出队 + reject；都不匹配→ok:false。 */
  cancel(runId: string): { ok: boolean } {
    const { logger } = this.ctx;
    // active 命中 → SIGKILL (finally 会写 cancelled 到 disk)
    const running = this.active.get(runId);
    if (running) {
      logger.info({ runId }, 'pragent run cancel: active');
      running.ac?.abort();
      return { ok: true };
    }
    // waiting 命中 → 从队列删除 + reject 原 Promise，不写盘 (从未真正跑过)
    const idx = this.waiting.findIndex((q) => q.info.runId === runId);
    if (idx >= 0) {
      const [removed] = this.waiting.splice(idx, 1);
      logger.info({ runId, queueLen: this.waiting.length }, 'pragent run cancel: queued');
      removed!.reject(new Error('queued run cancelled'));
      this.broadcastQueueChanged();
      return { ok: true };
    }
    return { ok: false };
  }

  /** 当前队列快照（pragent:queue / 广播用）。 */
  snapshot(): { active: PragentRunInfo[]; waiting: PragentRunInfo[] } {
    return {
      active: [...this.active.values()].map((q) => q.info),
      waiting: this.waiting.map((q) => q.info),
    };
  }

  /** 取消某 PR 的全部 run：active 的 SIGKILL，waiting 的出队 + reject。 */
  cancelRunsForPr(localId: string): void {
    for (const item of this.active.values()) if (item.req.localId === localId) item.ac?.abort();
    let removed = false;
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      if (this.waiting[i]!.req.localId === localId) {
        const [q] = this.waiting.splice(i, 1);
        q!.reject(new Error('pr removed'));
        removed = true;
      }
    }
    if (removed) this.broadcastQueueChanged();
  }

  /** active + waiting 涉及的 PR localId 集合（terminateAgentsForGonePrs 用）。 */
  queuedPrLocalIds(): string[] {
    const ids: string[] = [];
    for (const item of this.active.values()) ids.push(item.req.localId);
    for (const item of this.waiting) ids.push(item.req.localId);
    return ids;
  }

  /** 应用退出时中止所有进行中的 run，返回被中止的 run 数。 */
  abortAllActiveRuns(): number {
    let n = 0;
    for (const item of this.active.values()) {
      item.ac?.abort();
      n++;
    }
    return n;
  }

  private broadcastQueueChanged(): void {
    this.ctx.broadcast('pragent:queueChanged', this.snapshot());
  }

  /**
   * 队列泵：在并发未达上限且 waiting 非空时，连续 dequeue 起跑，直到填满 maxConcurrency。
   * 每条 run 结束（成功/失败/取消）后从 active 移除并再泵一次，自然续上后续任务。
   */
  private pump(): void {
    while (this.active.size < this.maxConcurrency && this.waiting.length > 0) {
      const item = this.waiting.shift()!;
      this.active.set(item.info.runId, item);
      item.ac = new AbortController();
      void this.executeRun(item)
        .then((finished) => item.resolve(finished))
        .catch((err: unknown) => {
          item.reject(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          this.active.delete(item.info.runId);
          this.broadcastQueueChanged();
          // 放微任务里再泵，避免递归栈累积
          queueMicrotask(() => this.pump());
        });
    }
    this.broadcastQueueChanged();
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

  /**
   * 真正执行一个 queue item：startReviewRun → worktree → bridge.run → finishWith。
   * 由 pump() 调用；任何抛错都被 pump 兜成 Promise reject，外层 pragent:run 调用方收到。
   */
  private async executeRun(item: QueueItem): Promise<ReviewRun> {
    const {
      bootstrap,
      logger,
      getPrAgentBridge,
      embeddedPythonPath,
      stateStore,
      repoMirror,
      broadcast,
      effectiveAgentDir,
      pr: prService,
    } = this.ctx;

    const prAgentBridge = getPrAgentBridge();
    if (!prAgentBridge) throw new Error(t('prAgent.notReady'));
    const { req, pr } = item;
    // 提前 resolve active LLM profile — model 字段要随 startReviewRun 一起落
    // 盘，让 UI 在 meta 行展示"这次 run 用的什么模型"。后面 buildPragentEnv
    // 同样会用到，这里 resolve 一次复用
    const activeLlmForRecord = resolveActiveLlmProfile(bootstrap.config.llm);
    // 用入队预分配的 runId 覆盖 startReviewRun 的自生 id，让 cancel(runId) 在 active
    // 状态也能精确定位 (跟入队时给的 runId 一致)
    const run = await startReviewRun(stateStore, {
      id: item.info.runId,
      prLocalId: pr.localId,
      tool: req.tool,
      question: req.tool === 'ask' ? req.question : undefined,
      prAgentVersion: prAgentBridge.version,
      strategy: prAgentBridge.strategy,
      // 持久化用 profile.model 原文，不做 normalizeModel 前缀处理 — 跟用户
      // Settings 里看到的名字一致更直观
      model: activeLlmForRecord?.model || undefined,
    });
    // 把入队时 startedAt=null 的 info 升级为 active 形态 + 广播
    item.info = { ...item.info, startedAt: run.startedAt };
    this.broadcastQueueChanged();
    logger.info(
      { runId: run.id, localId: pr.localId, tool: req.tool, strategy: prAgentBridge.strategy },
      'pragent run start',
    );
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

    const repoId = prService.repoIdentityFor(pr);
    await repoMirror.syncMirror(repoId);
    // pr-agent 的 LOCAL__TARGET_BRANCH 用固定 merge-base（与 UI diff 同源）：让 AI 评审基于
    // 「PR 自分叉后引入的改动」，而非 targetRef.sha 漂移后混入别的 PR 的两点对比
    const diffBase = await prService.resolveDiffBaseSha(pr);
    const wt = await repoMirror.materializeWorktree(repoId, pr.sourceRef.sha, diffBase);
    const ac = item.ac!;
    try {
      const activeLlm = resolveActiveLlmProfile(bootstrap.config.llm);
      // LLM env + 全局 pr-agent 配置 (响应语言)。语言配置一期写死在 config 里，
      // UI 还不暴露切换；后续多语言时改成 Settings 入口
      const env: Record<string, string> = {
        // 代理 env 先铺底，LLM/语言配置在后（互不冲突，仅 HTTP(S)_PROXY 类）。
        // 开关开时让嵌入式 python(litellm/httpx) 经代理出网调 LLM。
        ...buildProxyEnv(bootstrap.config.proxy),
        ...(activeLlm ? buildPragentEnv(activeLlm) : {}),
        CONFIG__RESPONSE_LANGUAGE: getMainLanguage(),
      };
      if (req.tool === 'improve') {
        // /improve 在 local provider 下只有「汇总建议 → publish_comment」一条可用路径
        // （shim 已强制 gfm_markdown=True）。committable/inline 模式会走
        // publish_code_suggestions → local provider 直接 NotImplementedError，显式关死兜底
        // （pr-agent 默认即 false，此处防上游翻默认值）。
        env['PR_CODE_SUGGESTIONS__COMMITABLE_CODE_SUGGESTIONS'] = 'false';
        // persistent_comment（默认 true）会走 publish_persistent_comment_with_history →
        // get_issue_comments() 翻历史评论做增量更新 → local provider 不实现，每次 improve
        // 都刷一段 NotImplementedError traceback（被上游捕获后兜底 publish_comment，正文
        // 不丢但日志吵）。local 每次都是全新 worktree、无历史可翻，直接关掉走 publish_comment。
        env['PR_CODE_SUGGESTIONS__PERSISTENT_COMMENT'] = 'false';
        // 输出与 /review /ask 的 review.md 分流：pr-agent 原生支持 local.review_path 覆盖
        // publish_comment 的落盘路径；相对路径按子进程 cwd（= worktree 根）解析。
        env['LOCAL__REVIEW_PATH'] = 'improve.md';
      }

      // PR 上下文 + 命中规则：local provider 不会自己去远端拉，须现读喂给 EXTRA_INSTRUCTIONS；
      // /ask 跳过（用户问题往往跟历史评论 / 规约无关）。提示词文本的组装见 @meebox/pr-agent-bridge 的 prompts。
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
              { err, runId: run.id, localId: pr.localId },
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
        logger.info(
          { runId: run.id, ruleId: matchedRuleId, tool: req.tool },
          'pragent run: matched rule',
        );
      }
      if (prContext) {
        logger.debug(
          { runId: run.id, tool: req.tool, contextChars: prContext.length },
          'pragent run: pr context injected',
        );
      }

      // ask 工具：问题作为位置参数（user turn，spawn args 单元素，含空格也是一个 arg 不切分），
      // 并在问题**末尾**硬性追加语言要求。系统侧 CONFIG__RESPONSE_LANGUAGE / EXTRA_INSTRUCTIONS 对
      // 自由问答常被大量英文 diff（full diff 数万 token）盖过 → 模型用英文作答；在 user turn 末尾
      // （近因位置、用目标语言书写）再要求一次，显著提升按 UI 语言作答的遵循度。en-US 返回空、不追加。
      const askLangSuffix = req.tool === 'ask' ? askLanguageSuffixFor(getMainLanguage()) : '';
      const askQuestion =
        req.tool === 'ask' && req.question
          ? askLangSuffix
            ? `${req.question}\n\n${askLangSuffix}`
            : req.question
          : undefined;
      const extraArgs = askQuestion ? [askQuestion] : undefined;

      // embedded 策略：执行期在嵌入式安装目录补空 .secrets.toml 压掉启动告警
      // （直接写安装目录；memo 化只首次做）。local-cli 不需要 (pipx 装的 pr-agent
      // 路径不同，告警也不出)
      if (prAgentBridge.strategy === 'embedded' && embeddedPythonPath) {
        await this.ensureEmbeddedSecrets(embeddedPythonPath);
      }

      const result = await prAgentBridge.run({
        prUrl: pr.url,
        tool: req.tool,
        env,
        onLine,
        cwd: wt.path,
        targetBranch: wt.targetBranchName,
        extraArgs,
        signal: ac.signal,
      });
      // 真实 token 用量（onLine 累加的 stderr 哨兵行），落到 succeeded / llm-failed 收尾。
      const tokenUsage = finalizeUsage(usageAcc);
      // pr-agent 的 local provider 把生成结果**写到工作树根的 markdown 文件**：
      //   /describe → <wt>/description.md  (走 publish_description)
      //   /review   → <wt>/review.md       (走 publish_comment)
      //   /ask      → <wt>/review.md       ← 共用同一文件 (publish_comment 会覆盖)
      //   /improve  → <wt>/improve.md      ← 汇总建议走 publish_comment，经 LOCAL__REVIEW_PATH
      //                                      重定向与 review.md 分流（见上方 env 注入）
      // 走 worktree 路径，cleanup 前必须先把文件读出来。
      const outFile =
        req.tool === 'describe'
          ? 'description.md'
          : req.tool === 'improve'
            ? 'improve.md'
            : 'review.md';
      let fileContent = '';
      try {
        fileContent = await fs.readFile(path.join(wt.path, outFile), 'utf8');
      } catch (readErr) {
        logger.warn(
          { err: readErr, wtPath: wt.path, outFile, runId: run.id },
          'pr-agent local provider output file missing; fall back to stdout',
        );
      }
      // /ask 输出里 pr-agent 把问题原样回显在 answer body 顶部 (跟 chat 输入气泡完全
      // 重复)。在解析前把跟用户问题逐字匹配的整行删掉，避免渲染时出现两次问题
      const cleanedContent =
        req.tool === 'ask' && req.question?.trim()
          ? stripAskQuestionEcho(fileContent, req.question, askLangSuffix)
          : fileContent;
      const parsed = parseReviewOutput(cleanedContent || result.stdout, req.tool);
      // M4 草稿再摄入：/review 成功完成时丢掉 pending+finding 旧草稿，
      // 让本轮 ChatPane 上的 finding 列表成为新的候选源。edited/posted/rejected/
      // manual 保留不动。失败的 /review 不触发清理 (没建设性数据)。
      if (req.tool === 'review') {
        try {
          const dropped = await dropPendingFindingDrafts(stateStore, pr.localId);
          if (dropped > 0) {
            logger.info(
              { runId: run.id, localId: pr.localId, dropped },
              'pragent /review: dropped stale pending drafts',
            );
            broadcast('drafts:changed', { localId: pr.localId });
          }
        } catch (err) {
          logger.warn({ err, runId: run.id }, 'dropPendingFindingDrafts failed');
        }
      }
      // pr-agent CLI 可能 exit 0 但 stdout 里其实是 LLM 调用全失败 (litellm
      // AuthenticationError / "Failed to generate prediction with any model" 等
      // marker)。parseReviewOutput 会在 ParsedReviewOutput.llmFailure 标出 —
      // 此时不算 succeeded，落盘为 failed + reason='llm-error'，UI 用红色失败
      // chip 渲染而不是"完成"
      if (parsed.llmFailure) {
        logger.warn(
          { runId: run.id, reason: parsed.llmFailure.message },
          'pragent exit 0 but LLM call failed; marking run as failed',
        );
        return await finishWith({
          status: 'failed',
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - t0,
          exitCode: result.exitCode,
          errorReason: 'llm-error',
          errorMessage: parsed.llmFailure.message,
          stdout: fileContent
            ? `${fileContent}\n\n---\n[pr-agent stdout log]\n${result.stdout}`
            : result.stdout,
          stderr: stripUsageSentinels(result.stderr),
          findings: parsed.findings,
          summary: parsed.summary,
          tokenUsage,
        });
      }
      return await finishWith({
        status: 'succeeded',
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        exitCode: result.exitCode,
        // 持久化「LLM 真实产出」(文件内容)；stdout 留作日志在折叠区供排障
        stdout: fileContent
          ? `${fileContent}\n\n---\n[pr-agent stdout log]\n${result.stdout}`
          : result.stdout,
        stderr: stripUsageSentinels(result.stderr),
        findings: parsed.findings,
        summary: parsed.summary,
        tokenUsage,
      });
    } catch (err) {
      if (err instanceof PrAgentRunError) {
        // 用户主动取消 → status='cancelled'，其它 reason → 'failed'。
        // 二者都仍走 finishReviewRun 落盘，让 UI 能从历史 run 里看到这次取消事件
        const status: ReviewRunStatus = err.reason === 'cancelled' ? 'cancelled' : 'failed';
        logger.warn(
          { runId: run.id, reason: err.reason, exitCode: err.result.exitCode },
          `pragent run ${status}`,
        );
        // 失败 / 取消时也尽量解析已收集的 stdout：很多情况 pr-agent 已写了一部分输出
        const partialStdout = err.result.stdout ?? '';
        const parsed = partialStdout
          ? parseReviewOutput(partialStdout, req.tool)
          : { findings: [], summary: undefined };
        // 失败 / 取消前可能已有若干次 LLM 调用，尽量把已产生的 token 用量也记上
        const tokenUsage = finalizeUsage(usageAcc);
        return await finishWith({
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
        });
      }
      // 非预期异常：仍记一笔 failed，避免 run 永远卡在 running，再把异常往上抛
      await finishWith({
        status: 'failed',
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      await wt.cleanup();
    }
  }
}
