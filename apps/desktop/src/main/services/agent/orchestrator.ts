import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendAgentMessage, listStoredPullRequests, writeAutopilotLedger } from '@meebox/poller';
import { buildChatEnv } from '@meebox/pr-agent-bridge';
import type { AgentSession, AgentStep, StoredPullRequest } from '@meebox/shared';
import { getMainLanguage, t } from '../../i18n/index.js';
import { resolveActiveLlmProfile } from '../../utils/agent.js';
import { buildProxyEnv } from '../../utils/proxy.js';
import type { ServiceContext } from '../context.js';
import type { RunQueue } from '../pr-agent/index.js';
import { accumulateUsageSentinel, finalizeUsage, newUsageAcc } from '../usage.js';
import { autopilotPass } from './flows/autopilot.js';
import { planningFlow } from './flows/planning.js';
import { reviewFlow } from './flows/review.js';
import type { AgentChat, OrchestratorRuntime } from './runtime.js';

/**
 * Agent 编排服务（有状态协调器）：手动评审（agent:run）、自由规划（agent:ask）、AutoPilot 后台预评审，
 * 以及随 poll tick 清理已消失 PR 的在跑操作。运行态（每 PR 的 AbortController、「执行中」集合、AutoPilot
 * busy 锁、中途输入队列）是实例可变状态，故以 class 封装并实现 OrchestratorRuntime——把状态访问 + 共享
 * helper（withAgentChat / 收尾落地 / 步骤广播等）暴露给按「一任务一文件」拆分的各 flow（见 ./flows）。
 */
export class Orchestrator implements OrchestratorRuntime {
  // 编排 Agent 每 PR 至多一个在跑，AbortController 供 agent:stop 即时中止——思考 / 工具执行任意阶段都能停。
  private readonly agentControllers = new Map<string, AbortController>();
  // 运行中（思考或派发工具）的编排 Agent 所属 PR 集合，向 renderer 广播「执行中」。手动 run/ask 与
  // AutoPilot 后台评审一并计入，让 PR 列表项在纯思考阶段（无活跃工具 run）也显示执行中标记。
  private readonly runningAgentPrs = new Set<string>();
  // Agent 编排层全局单并发：一次只跑一遍 AutoPilot pass（busy 锁），防止上一遍未完又叠跑。
  private autopilotBusy = false;
  // 中途输入转向：每 PR 一个待处理用户消息队列（运行中追加 → 入队，下一周期 drain 注入）。
  private readonly pendingInputByPr = new Map<string, string[]>();

  constructor(
    readonly ctx: ServiceContext,
    readonly runQueue: RunQueue,
  ) {}

  // ── 公共 API（IPC 入口；委托给 ./flows 下按任务拆分的各 flow）──

  /** 对指定 PR 跑评审微流程（agent:run）。 */
  runReview(pr: StoredPullRequest): Promise<AgentSession> {
    return reviewFlow(this, pr);
  }

  /** 对指定 PR 跑自由规划 Agent（agent:ask）。 */
  runPlanning(
    pr: StoredPullRequest,
    question: string,
    referencedContext?: string,
  ): Promise<AgentSession> {
    return planningFlow(this, pr, question, referencedContext);
  }

  /**
   * 运行期间追加用户消息（agent:enqueueMessage）：有 Agent 在跑 → 入队，下一主 Agent 周期 drain 注入
   * （queued=true）；无在跑 → 直接起一轮自由规划兜底（queued=false，fire-and-forget，不丢消息）。
   */
  enqueueMessage(pr: StoredPullRequest, message: string): { queued: boolean } {
    const text = message.trim();
    if (!text) return { queued: false };
    if (this.agentControllers.has(pr.localId)) {
      const q = this.pendingInputByPr.get(pr.localId) ?? [];
      q.push(text);
      this.pendingInputByPr.set(pr.localId, q);
      this.ctx.logger.info(
        { prLocalId: pr.localId, queueLen: q.length },
        'agent message queued (mid-run)',
      );
      return { queued: true };
    }
    // 竞态兜底：检查到没有在跑 → 直接起一轮自由规划（UI 经 step / conversation 事件更新）。
    void this.runPlanning(pr, text).catch((err: unknown) => {
      this.ctx.logger.warn({ err, prLocalId: pr.localId }, 'enqueueMessage fallback planning failed');
    });
    return { queued: false };
  }

  /** 暂停某 PR 的 Agent 运行（agent:stop）：abort 其 AbortController。 */
  stop(localId: string): { ok: boolean } {
    const ac = this.agentControllers.get(localId);
    if (!ac) return { ok: false };
    ac.abort();
    return { ok: true };
  }

  /**
   * poll tick：满足开关 + 未在跑 + bridge 就绪时跑一遍 AutoPilot pass（准入门控 + 台账去重在 autopilotPass
   * 内）。busy 锁防止上一遍未完又叠跑。见 docs/arch/06-agent.md「AutoPilot」。
   */
  runAutopilotIfDue(): void {
    const ap = this.ctx.bootstrap.config.agent.autopilot;
    if (!ap.enabled || this.autopilotBusy || !this.ctx.getPrAgentBridge()) return;
    // 准入通过 → fire-and-forget 异步 pass（poll tick 不阻塞）；busy 锁在 autopilotPass 内成对管理。
    void autopilotPass(this);
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

  // ── OrchestratorRuntime 实现（供 ./flows 复用的状态访问 + 共享 helper）──

  registerController(localId: string, ac: AbortController): void {
    this.agentControllers.set(localId, ac);
  }

  clearController(localId: string): void {
    this.agentControllers.delete(localId);
  }

  markRunning(localId: string): void {
    this.runningAgentPrs.add(localId);
    this.broadcastAgentRunning();
  }

  unmarkRunning(localId: string): void {
    if (this.runningAgentPrs.delete(localId)) this.broadcastAgentRunning();
  }

  setAutopilotBusy(busy: boolean): void {
    this.autopilotBusy = busy;
  }

  /** 取出并清空某 PR 的待处理用户消息队列。 */
  takePending(localId: string): string[] {
    const q = this.pendingInputByPr.get(localId);
    if (!q || q.length === 0) return [];
    this.pendingInputByPr.delete(localId);
    return q;
  }

  /**
   * 每个编排步骤的统一出口：① 后台日志（kind / tool / 用时，便于排障与离线回看；thought 与 result 不入
   * 日志避免刷屏 + 泄漏，完整步骤已落 transcript.json）；② 广播给渲染层（agent:stepProgress）做过程化展示。
   */
  emitStep(pr: StoredPullRequest, sessionId: string, step: AgentStep): void {
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

  /** 设置 LLM env + 临时 chat cwd + chat 函数，运行 fn，收尾清理临时目录。
   *  signal：用户停止时 abort → 杀掉在跑的 LLM chat 子进程，让思考阶段也能立即中止（不必等模型返回）。 */
  async withAgentChat<T>(fn: (chat: AgentChat) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const { getPrAgentBridge, bootstrap } = this.ctx;
    const bridge = getPrAgentBridge();
    if (!bridge) throw new Error(t('prAgent.notReadyDetail'));
    // 复用与 pr-agent run 同一套 LLM env（provider 凭据 / 模型 / 代理 / 响应语言）。代理 env 先铺底（非
    // pr-agent 范畴）；LLM 凭据/模型 + 编排 chat 专属档（响应语言 / 低推理档 / 提示缓存）由 buildChatEnv 按
    // 意图组装。低档与缓存仅作用于本 chat spawn：pr-agent 工具 run（/review 等）的 env 不含 → 仍满档推理。
    const activeLlm = resolveActiveLlmProfile(bootstrap.config.llm);
    const env: Record<string, string> = {
      ...buildProxyEnv(bootstrap.config.proxy),
      ...buildChatEnv(activeLlm, {
        responseLanguage: getMainLanguage(),
        lowReasoning: true,
        promptCache: true,
      }),
    };
    // chat 子进程落到中性临时目录（cli 模式避免吃到被评审仓库的 CLAUDE.md）。
    const chatCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'meebox-agent-chat-'));
    try {
      const chat: AgentChat = async ({ system, user, maxOutputTokens }) => {
        const r = await bridge.chat({ system, user, maxOutputTokens, env, cwd: chatCwd, signal });
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
   * 评审收尾的统一落地（手动一键评审与 AutoPilot 背景评审共用）：仅成功收尾（done）且有总结时——
   * ① 追加一条 assistant 评审消息（UI 渲染「评审总结」卡片）；② 写评审台账（recommendation + 当前
   *    updatedAt，给 PR 列表建议徽标 + AutoPilot 同版本去重）。失败 / 用户停止（paused）不落，便于重试。
   */
  async recordReviewSummaryMessage(pr: StoredPullRequest, session: AgentSession): Promise<void> {
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

  // ── 私有 helper ──

  private broadcastAgentRunning(): void {
    this.ctx.broadcast('agent:runningChanged', { prLocalIds: [...this.runningAgentPrs] });
  }

  /** 终止某 PR 上的全部 agent 操作：中止编排（agent:run/ask）+ 取消其派发的工具 run。 */
  private terminateAgentForPr(localId: string): void {
    this.agentControllers.get(localId)?.abort();
    this.runQueue.cancelRunsForPr(localId);
  }
}
