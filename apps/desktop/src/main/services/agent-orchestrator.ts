import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendAgentNotes,
  buildToolCatalog,
  judgeAutopilotBatch,
  loadAgentContext,
} from '@meebox/agent';
import type { AgentContext } from '@meebox/agent';
import {
  appendAgentMessage,
  getAutopilotLedger,
  hasReviewOutput,
  listStoredPullRequests,
  writeAutopilotLedger,
} from '@meebox/poller';
import { pickMatchingRule } from '@meebox/rules';
import type { AgentSession, AgentStep, StoredPullRequest, TokenUsage } from '@meebox/shared';
import { runAgentPlanning } from '../agent-planning.js';
import { runAgentReview } from '../agent-review.js';
import { getMainLanguage, t } from '../i18n/index.js';
import { buildPragentEnv, resolveActiveLlmProfile } from '../utils/agent.js';
import { buildProxyEnv } from '../utils/proxy.js';
import type { ServiceContext } from './context.js';
import type { RunQueueService } from './run-queue.js';
import { accumulateUsageSentinel, finalizeUsage, newUsageAcc } from './usage.js';

// 共享 chat 通道：system + user → 文本 + usage。agent:run 评审与 AutoPilot 都用。
type AgentChat = (input: {
  system: string;
  user: string;
}) => Promise<{ text: string; usage?: TokenUsage }>;

/**
 * Agent 编排服务：手动评审（agent:run）、自由规划（agent:ask）、AutoPilot 后台预评审，
 * 以及随 poll tick 清理已消失 PR 的在跑操作。
 *
 * 运行态（每 PR 的 AbortController、「执行中」PR 集合、AutoPilot busy 锁）是实例可变状态，
 * 故以 class 封装；派发的工具 run 复用注入的 RunQueueService（agent 低优先级泳道）。
 */
export class AgentOrchestratorService {
  // 编排 Agent（手动评审 agent:run + 自由规划 agent:ask）每 PR 至多一个在跑，AbortController 供
  // agent:stop 即时中止——思考 / 工具执行任意阶段都能停。
  private readonly agentControllers = new Map<string, AbortController>();
  // 运行中（思考或派发工具）的编排 Agent 所属 PR 集合，向 renderer 广播「执行中」。区别于
  // agentControllers（仅手动可停会话）：这里**手动 run/ask 与 AutoPilot 后台评审一并计入**，
  // 让 PR 列表项在纯思考阶段（无活跃工具 run）也显示执行中标记。
  private readonly runningAgentPrs = new Set<string>();
  // Agent 编排层全局单并发：一次只跑一遍 AutoPilot pass（busy 锁），防止上一遍未完又叠跑。
  private autopilotBusy = false;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly runQueue: RunQueueService,
  ) {}

  /**
   * 对指定 PR 跑评审微流程（agent:run）：现读现装配上下文 + 注册 AbortController + 标记执行中，
   * 收尾把「评审总结」落多轮对话与台账。
   */
  async runReview(pr: StoredPullRequest): Promise<AgentSession> {
    const { getPrAgentBridge, effectiveAgentDir, logger } = this.ctx;
    if (!getPrAgentBridge()) throw new Error(t('prAgent.notReadyDetail'));
    // 现读现装配 Agent 上下文（SOUL/AGENTS/MEMORY/USER + rules），无缓存。
    const agentContext = await loadAgentContext(effectiveAgentDir(), {
      onWarn: (msg, file) => logger.warn({ file }, `agent context: ${msg}`),
    });
    // 注册 AbortController，让停止按钮（agent:stop）能在思考 / 执行任意阶段即时中止本次评审。
    const ac = new AbortController();
    this.agentControllers.set(pr.localId, ac);
    this.markAgentRunning(pr.localId);
    logger.info({ prLocalId: pr.localId }, 'agent review start (manual)');
    try {
      const session = await this.withAgentChat(
        (chat) => this.runReviewForPr(pr, agentContext, chat, ac.signal),
        ac.signal,
      );
      logger.info(
        { prLocalId: pr.localId, status: session.status, steps: session.stepCount },
        'agent review done',
      );
      // 收尾总结计入多轮对话（assistant 评审消息）→ UI 渲染「评审总结」卡片。
      await this.recordReviewSummaryMessage(pr, session);
      return session;
    } finally {
      this.agentControllers.delete(pr.localId);
      this.unmarkAgentRunning(pr.localId);
    }
  }

  /** 对指定 PR 跑自由规划 Agent（agent:ask）。 */
  async runPlanning(pr: StoredPullRequest, question: string): Promise<AgentSession> {
    const { getPrAgentBridge, effectiveAgentDir, logger } = this.ctx;
    if (!getPrAgentBridge()) throw new Error(t('prAgent.notReadyDetail'));
    const agentContext = await loadAgentContext(effectiveAgentDir(), {
      onWarn: (msg, file) => logger.warn({ file }, `agent context: ${msg}`),
    });
    const ac = new AbortController();
    this.agentControllers.set(pr.localId, ac);
    this.markAgentRunning(pr.localId);
    // 不记用户输入正文（避免泄漏 / 刷屏）：只记发起本身，输入已落多轮对话。
    logger.info({ prLocalId: pr.localId }, 'agent chat start (planning)');
    try {
      const session = await this.withAgentChat(
        (chat) => this.runPlanningForPr(pr, question, agentContext, chat, ac.signal),
        ac.signal,
      );
      logger.info(
        {
          prLocalId: pr.localId,
          status: session.status,
          steps: session.stepCount,
          terminationReason: session.terminationReason,
        },
        'agent chat done',
      );
      return session;
    } finally {
      this.agentControllers.delete(pr.localId);
      this.unmarkAgentRunning(pr.localId);
    }
  }

  /** 暂停某 PR 的 Agent 运行（agent:stop）：abort 其 AbortController。 */
  stop(localId: string): { ok: boolean } {
    const ac = this.agentControllers.get(localId);
    if (!ac) return { ok: false };
    ac.abort();
    return { ok: true };
  }

  /**
   * poll tick：满足开关 + 候选时跑一遍 AutoPilot pass（内部门控）。见 docs/arch/06-agent.md「AutoPilot」。
   * Agent 编排层全局单并发：busy 锁防止上一遍未完又叠跑；派发的工具 run 在共享队列并行。
   * 触发节奏对齐轮询（每个 onTick 评估一遍）；准入门控 + 台账去重防止重复评审 / 打爆 LLM。
   */
  runAutopilotIfDue(): void {
    const ap = this.ctx.bootstrap.config.agent.autopilot;
    if (!ap.enabled || this.autopilotBusy || !this.ctx.getPrAgentBridge()) return;
    // 准入通过 → fire-and-forget 异步 pass（poll tick 不阻塞）；busy 锁在 runAutopilotPass 内成对管理。
    void this.runAutopilotPass();
  }

  /** 跑一遍 AutoPilot pass（busy 锁置位 / 复位包住全程）。仅由 runAutopilotIfDue 通过准入后触发。 */
  private async runAutopilotPass(): Promise<void> {
    const { bootstrap, stateStore, effectiveAgentDir, logger } = this.ctx;
    const ap = bootstrap.config.agent.autopilot;
    this.autopilotBusy = true;
    try {
      // 候选准入（硬性门控，自上而下）：
      //   1. 仅「待我评审」分类（discoveryFilters 含 review-requested）下、「待处理」状态（localStatus
      //      === 'pending'）的 PR —— 已通过 / 标记需修改、或非待我评审的一律不自动评审。
      //      （不支持发现分类的平台 discoveryFilters 为空 → 不命中，自然不自动触发。）
      //   2. 会话中已有 /describe 或 /review 产出（成功 / 正在跑，手动或自动）→ 判定已评审过 / 评审中，
      //      不再自动触发（评审失败无产出 → 不算，下轮可重试）。
      //   3. 仅排除「本版本已被判定跳过」的 PR（台账 decision='skipped'）——避免对判过 skip 的 PR 反复
      //      重判；无产出又未被 skip 的待评审 PR 一律放行（不再因台账有任意记录就拦下）。
      //   再按 batch_size 截断。
      const prs = await listStoredPullRequests(stateStore);
      const candidates: StoredPullRequest[] = [];
      // 准入漏斗计数（用于 0 候选时定位卡在哪一道闸——便于排查「为何不再触发」）。
      let reviewReqPending = 0; // 命中「待我评审 + 待处理」
      let alreadyReviewed = 0; // 其中已有 describe/review 产出（成功 / 进行中）而被排除
      let skipDeduped = 0; // 其中本版本已被判定跳过而被排除
      for (const pr of prs) {
        if (candidates.length >= ap.batch_size) break;
        if (!pr.discoveryFilters.includes('review-requested')) continue;
        if (pr.localStatus !== 'pending') continue;
        reviewReqPending++;
        if (await hasReviewOutput(stateStore, pr.localId)) {
          alreadyReviewed++;
          continue;
        }
        const ledger = await getAutopilotLedger(stateStore, pr.localId);
        if (ledger?.decision === 'skipped' && ledger.autoReviewedUpdatedAt === pr.updatedAt) {
          skipDeduped++;
          continue;
        }
        candidates.push(pr);
      }
      if (candidates.length === 0) {
        // 仍在按周期评估，只是当前无新合格 PR——把漏斗计数打出来，避免被误读成「没在跑」。
        logger.info(
          { total: prs.length, reviewReqPending, alreadyReviewed, skipDeduped },
          'autopilot pass: no eligible candidates',
        );
        return;
      }

      const agentContext = await loadAgentContext(effectiveAgentDir(), {
        onWarn: (msg, file) => logger.warn({ file }, `agent context: ${msg}`),
      });
      await this.withAgentChat(async (chat) => {
        // 批量判定（例外规则来自 AGENTS.md）。
        const { decisions } = await judgeAutopilotBatch(chat, {
          candidates: candidates.map((p) => ({
            prLocalId: p.localId,
            title: p.title,
            description: p.description,
          })),
          agentsRules: agentContext.files.agents,
        });
        const byId = new Map(candidates.map((p) => [p.localId, p] as const));
        // 先落「跳过」决策（无工具开销，顺序写盘即可）；收集「评审」决策待并行编排。
        const toReview: StoredPullRequest[] = [];
        for (const d of decisions) {
          const pr = byId.get(d.prLocalId);
          if (!pr) continue;
          if (!d.review) {
            // 输出判定 skip 的原因（候选都已过准入闸、非「已评审」，故这里的原因都是 LLM 的领域判定，
            // 如分支合并 / 纯依赖升级 — 打出来便于核对「为何没评审这个 PR」）。
            logger.info({ prLocalId: pr.localId, reason: d.reason }, 'autopilot judge skip');
            await writeAutopilotLedger(stateStore, {
              prLocalId: pr.localId,
              autoReviewedUpdatedAt: pr.updatedAt,
              decision: 'skipped',
              reason: d.reason,
              at: new Date().toISOString(),
            });
            continue;
          }
          toReview.push(pr);
        }
        // 多 PR 评审并行编排：各编排 await 自己的工具 run 时彼此不挡，让工具的并发队列
        // （run-queue maxConcurrency）尽量被填满，而非逐 PR 串行空等。各 PR 写各自的文件，无竞争。
        await Promise.all(
          toReview.map(async (pr) => {
            // AutoPilot 后台评审无 AbortController，但同样标记「执行中」——纯思考阶段也在 PR 列表项显示。
            this.markAgentRunning(pr.localId);
            try {
              const session = await this.runReviewForPr(pr, agentContext, chat, undefined, true);
              // done：落「评审总结」消息 + 台账（含 verdict）+ 广播会话变更（与手动评审一致）。
              // 失败 / 暂停不落台账 → 无产出，下轮可重试（准入闸 2 用 hasReviewOutput 判，不再靠台账拦）。
              await this.recordReviewSummaryMessage(pr, session);
            } finally {
              this.unmarkAgentRunning(pr.localId);
            }
          }),
        );
      });
      logger.info({ candidates: candidates.length }, 'autopilot pass done');
    } catch (err) {
      logger.warn({ err }, 'autopilot pass failed (ignored)');
    } finally {
      this.autopilotBusy = false;
    }
  }

  /**
   * poll tick 后调用：把已被移除 / purge（不再在 listStoredPullRequests 里）的 PR 上仍在执行的
   * agent 操作一律直接终止——PR 都没了，继续评审无意义且浪费 LLM / 占用 worktree。
   */
  async terminateAgentsForGonePrs(): Promise<void> {
    const { stateStore, logger } = this.ctx;
    const opPrIds = new Set<string>();
    for (const id of this.agentControllers.keys()) opPrIds.add(id);
    for (const id of this.runQueue.queuedPrLocalIds()) opPrIds.add(id);
    if (opPrIds.size === 0) return;
    const live = new Set((await listStoredPullRequests(stateStore)).map((p) => p.localId));
    for (const id of opPrIds) {
      if (!live.has(id)) {
        logger.info({ prLocalId: id }, 'agent ops terminated: pr removed/purged');
        this.terminateAgentForPr(id);
      }
    }
  }

  /** 设置 LLM env + 临时 chat cwd + chat 函数，运行 fn，收尾清理临时目录。
   *  signal：用户停止时 abort → 杀掉在跑的 LLM chat 子进程，让思考阶段也能立即中止（不必等模型返回）。 */
  private async withAgentChat<T>(
    fn: (chat: AgentChat) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const { getPrAgentBridge, bootstrap } = this.ctx;
    const bridge = getPrAgentBridge();
    if (!bridge) throw new Error(t('prAgent.notReadyDetail'));
    // 复用与 pr-agent run 同一套 LLM env（provider 凭据 / 模型 / 代理 / 响应语言）。
    const activeLlm = resolveActiveLlmProfile(bootstrap.config.llm);
    const env: Record<string, string> = {
      ...buildProxyEnv(bootstrap.config.proxy),
      ...(activeLlm ? buildPragentEnv(activeLlm) : {}),
      CONFIG__RESPONSE_LANGUAGE: getMainLanguage(),
      // Agent 编排通道（规划 / 判读 / 收尾 / 对话）是路由 + 轻量综合，非深度代码分析（那在
      // pr-agent /review 里）。本机 CLI 模式下调低推理档（codex: model_reasoning_effort=minimal）
      // 提速；仅作用于本 chat spawn，pr-agent 工具 run 的 env 不含此项 → /review 仍满档推理。
      // 非 CLI 模式（API）由 CLI handler 之外的路径处理，该 env 无副作用。
      MEEBOX_CLI_REASONING: 'low',
    };
    // chat 子进程落到中性临时目录（cli 模式避免吃到被评审仓库的 CLAUDE.md）。
    const chatCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'meebox-agent-chat-'));
    try {
      const chat: AgentChat = async ({ system, user }) => {
        const r = await bridge.chat({ system, user, env, cwd: chatCwd, signal });
        const acc = newUsageAcc();
        for (const line of (r.stderr ?? '').split('\n')) accumulateUsageSentinel(line, acc);
        return { text: r.stdout.trim(), usage: finalizeUsage(acc) };
      };
      return await fn(chat);
    } finally {
      await fs.rm(chatCwd, { recursive: true, force: true });
    }
  }

  /**
   * 每个编排步骤的统一出口：① 后台日志（工具选择 / 判读 / 收尾各落一条，便于排障与离线回看）；
   * ② 广播给渲染层（agent:stepProgress）做过程化展示。
   * 后台日志只留骨架（kind / tool / 用时）：thought 与 result（含用户输入 / 总结正文）不入日志，
   * 避免刷屏 + 泄漏内容；完整步骤已落 transcript.json，需要时从那里回看。
   */
  private emitAgentStep(pr: StoredPullRequest, sessionId: string, step: AgentStep): void {
    this.ctx.logger.info(
      {
        prLocalId: pr.localId,
        sessionId,
        kind: step.kind,
        tool: step.toolCall?.tool,
        thinkMs: step.thinkMs,
      },
      'agent step',
    );
    this.ctx.broadcast('agent:stepProgress', { sessionId, prLocalId: pr.localId, step });
  }

  private broadcastAgentRunning(): void {
    this.ctx.broadcast('agent:runningChanged', { prLocalIds: [...this.runningAgentPrs] });
  }

  private markAgentRunning(localId: string): void {
    this.runningAgentPrs.add(localId);
    this.broadcastAgentRunning();
  }

  private unmarkAgentRunning(localId: string): void {
    if (this.runningAgentPrs.delete(localId)) this.broadcastAgentRunning();
  }

  /** 终止某 PR 上的全部 agent 操作：中止编排（agent:run/ask）+ 取消其派发的工具 run。 */
  private terminateAgentForPr(localId: string): void {
    this.agentControllers.get(localId)?.abort();
    this.runQueue.cancelRunsForPr(localId);
  }

  /** 对一个 PR 跑评审微流程（共用 enqueue 队列 / 持久化 / 步骤广播）。 */
  private runReviewForPr(
    pr: StoredPullRequest,
    agentContext: AgentContext,
    chat: AgentChat,
    signal?: AbortSignal,
    autopilot = false,
  ): Promise<AgentSession> {
    const agentCfg = this.ctx.bootstrap.config.agent;
    const matchedRule = pickMatchingRule(agentContext.rules, {
      projectKey: pr.repo.projectKey,
      repoSlug: pr.repo.repoSlug,
      targetBranch: pr.targetRef.displayId,
      tool: 'review',
    });
    return runAgentReview(pr, {
      stateStore: this.ctx.stateStore,
      // 编排派发的 run 走 agent 低优先级泳道：用户随时点 /review 会插到它们之前。
      enqueueRun: (p, tool, question) => this.runQueue.enqueuePragentRun(p, tool, question, 'agent'),
      chat,
      agentContext,
      matchedRule,
      language: getMainLanguage(),
      // 工具目录注入：修改类工具按 grants 门控（默认全禁，红线见 buildToolCatalog）。
      toolCatalog: buildToolCatalog(agentCfg.autopilot.grants),
      maxFollowupAsks: agentCfg.autopilot.max_followup_asks,
      summaryMaxChars: agentCfg.summary_max_chars,
      onStep: (sessionId, step) => this.emitAgentStep(pr, sessionId, step),
      signal,
      autopilot,
    });
  }

  private runPlanningForPr(
    pr: StoredPullRequest,
    userRequest: string,
    agentContext: AgentContext,
    chat: AgentChat,
    signal: AbortSignal,
  ): Promise<AgentSession> {
    const { bootstrap, effectiveAgentDir, logger } = this.ctx;
    const agentCfg = bootstrap.config.agent;
    const matchedRule = pickMatchingRule(agentContext.rules, {
      projectKey: pr.repo.projectKey,
      repoSlug: pr.repo.repoSlug,
      targetBranch: pr.targetRef.displayId,
      tool: 'review',
    });
    return runAgentPlanning(pr, userRequest, {
      stateStore: this.ctx.stateStore,
      enqueueRun: (p, tool, question) => this.runQueue.enqueuePragentRun(p, tool, question, 'agent'),
      chat,
      agentContext,
      toolCatalog: buildToolCatalog(agentCfg.autopilot.grants),
      matchedRule,
      language: getMainLanguage(),
      maxSteps: agentCfg.max_steps,
      signal,
      onStep: (sessionId, step) => this.emitAgentStep(pr, sessionId, step),
      // 持久化 Agent 主动记下的非隐私条目到当前 Agent 目录的各可写文件（USER/MEMORY/AGENTS）；
      // SOUL.md 永不写。下一轮 loadAgentContext 现读即生效（跨会话记忆）。
      recordMemory: async (notes) => {
        const dir = effectiveAgentDir();
        for (const kind of ['user', 'memory', 'agents'] as const) {
          const added = await appendAgentNotes(dir, kind, notes[kind]).catch((err: unknown) => {
            logger.warn({ err, kind }, 'record agent memory failed');
            return [] as string[];
          });
          if (added.length) logger.info({ kind, added }, 'agent memory recorded');
        }
      },
    });
  }

  /**
   * 评审收尾的统一落地（手动一键评审与 AutoPilot 背景评审共用）：仅成功收尾（done）且有总结时——
   * ① 追加一条 assistant 评审消息（UI 渲染「评审总结」卡片）；② 写评审台账（recommendation + 当前
   *    updatedAt）。台账既给 PR 列表的建议徽标（★，手动 / 自动一视同仁），也供 AutoPilot 同版本去重。
   * 失败 / 用户停止（paused）不落，便于后续重试。
   */
  private async recordReviewSummaryMessage(
    pr: StoredPullRequest,
    session: AgentSession,
  ): Promise<void> {
    if (session.status !== 'done' || !session.summary) return;
    await appendAgentMessage(this.ctx.stateStore, pr.localId, {
      role: 'assistant',
      content: session.summary,
      recommendation: session.recommendation,
    });
    await writeAutopilotLedger(this.ctx.stateStore, {
      prLocalId: pr.localId,
      autoReviewedUpdatedAt: pr.updatedAt,
      decision: 'review',
      recommendation: session.recommendation?.verdict,
      at: new Date().toISOString(),
    });
    // 通知渲染层：若正打开该 PR，重载会话让后台评审的「评审总结」卡片即时出现（手动评审自行重载，重复无害）。
    this.ctx.broadcast('agent:conversationChanged', { prLocalId: pr.localId });
  }
}
