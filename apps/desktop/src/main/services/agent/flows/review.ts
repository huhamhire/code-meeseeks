import { buildToolCatalog, DEFAULT_REVIEW_PLAN, loadAgentContext } from '@meebox/agent';
import type { AgentContext, ReviewPlan } from '@meebox/agent';
import { addFindingClosure } from '@meebox/poller';
import { pickMatchingRule } from '@meebox/rules';
import { AppError, ERROR_CODES, type AgentSession, type StoredPullRequest } from '@meebox/shared';
import { getMainLanguage } from '../../../i18n/index.js';
import { runReview } from '../review.js';
import type { AgentChat, OrchestratorRuntime } from '../runtime.js';
import { planningFlow } from './planning.js';

/**
 * 手动评审编排（agent:run）：现读现装配上下文 + 注册 AbortController + 标记执行中，跑评审微流程，收尾把
 * 「评审总结」落多轮对话与台账。评审微流程是固定模板、无法中途转向：跑完后把运行期间排队的用户消息作为
 * 一轮自由规划接续处理（fire-and-forget，本次评审会话照常返回）。
 */
export async function reviewFlow(
  runtime: OrchestratorRuntime,
  pr: StoredPullRequest,
): Promise<AgentSession> {
  const { getPrAgentBridge, ensureAgentDir, logger } = runtime.ctx;
  if (!getPrAgentBridge()) throw new AppError(ERROR_CODES.AG_PR_AGENT_NOT_READY);
  // 现读现装配 Agent 上下文（SOUL/AGENTS/MEMORY/USER + rules），无缓存；加载前先确保目录已初始化。
  const agentContext = await loadAgentContext(await ensureAgentDir(), {
    onWarn: (msg, file) => logger.warn({ file }, `agent context: ${msg}`),
  });
  // 注册 AbortController，让停止按钮（agent:stop）能在思考 / 执行任意阶段即时中止本次评审。
  const ac = new AbortController();
  runtime.registerController(pr.localId, ac);
  runtime.markRunning(pr.localId);
  logger.info({ prLocalId: pr.localId }, 'agent review start (manual)');
  let session: AgentSession;
  try {
    session = await runtime.withAgentChat(
      (chat) => runReviewForPr(runtime, pr, agentContext, chat, ac.signal),
      ac.signal,
    );
    logger.info(
      { prLocalId: pr.localId, status: session.status, steps: session.stepCount },
      'agent review done',
    );
    // 收尾总结计入多轮对话（assistant 评审消息）→ UI 渲染「评审总结」卡片。
    await runtime.recordReviewSummaryMessage(pr, session);
  } finally {
    runtime.clearController(pr.localId);
    runtime.unmarkRunning(pr.localId);
  }
  // 评审微流程无法中途转向：跑完后把排队的用户消息作为一轮自由规划接续处理（fire-and-forget）。
  const pending = runtime.takePending(pr.localId);
  if (pending.length) {
    void planningFlow(runtime, pr, pending.join('\n\n')).catch((err: unknown) => {
      logger.warn({ err, prLocalId: pr.localId }, 'post-review planning (queued input) failed');
    });
  }
  return session;
}

/**
 * 对一个 PR 跑评审微流程（共用 enqueue 队列 / 持久化 / 步骤广播）。手动评审与 AutoPilot 背景评审共用。
 * 编排派发的 run 走 agent 低优先级泳道；修改类工具按 grants 门控（红线见 buildToolCatalog）。
 */
export async function runReviewForPr(
  runtime: OrchestratorRuntime,
  pr: StoredPullRequest,
  agentContext: AgentContext,
  chat: AgentChat,
  signal?: AbortSignal,
  autopilot = false,
  /** 评审执行计划（仅 AutoPilot 按规则注入）；省略 → 微流程走默认全集。 */
  plan?: ReviewPlan,
): Promise<AgentSession> {
  const agentCfg = runtime.ctx.bootstrap.config.agent;
  // per-PR 存储路由：已归档（已关闭范围）PR 补跑评审时，会话 / run / 关闭关系都落归档冷存储。
  const store = await runtime.ctx.pr.storeForPr(pr.localId);
  // 自动追问关闭：评审微流程跳过 judge + asks（不判读、不条件追问），直接总结——省一次 judge LLM
  // 调用与潜在追问开销。覆盖默认计划与 AutoPilot 规则注入计划两种来源。
  const effectivePlan: ReviewPlan | undefined = agentCfg.strategy.auto_followup
    ? plan
    : {
        steps: (plan ?? DEFAULT_REVIEW_PLAN).steps.filter((k) => k !== 'judge' && k !== 'asks'),
      };
  const matchedRule = pickMatchingRule(agentContext.rules, {
    projectKey: pr.repo.projectKey,
    repoSlug: pr.repo.repoSlug,
    targetBranch: pr.targetRef.displayId,
    tool: 'review',
  });
  return runReview(pr, {
    stateStore: store,
    // 编排派发的 run 走 agent 低优先级泳道：用户随时点 /review 会插到它们之前。复评 /ask 携引用上下文 + 前向链。
    enqueueRun: (p, tool, question, referencedContext, referencedFinding) =>
      runtime.runQueue.enqueuePragentRun(
        p,
        tool,
        question,
        'agent',
        referencedContext,
        referencedFinding,
      ),
    // 复评裁决 replace/drop → 关闭被取代的原 review finding（写 FindingClosure + 广播刷新卡片）。
    closeFinding: async (p, call) => {
      await addFindingClosure(store, p.localId, call);
      runtime.ctx.broadcast('findingClosures:changed', { localId: p.localId });
    },
    chat,
    agentContext,
    matchedRule,
    language: getMainLanguage(),
    toolCatalog: buildToolCatalog(agentCfg.autopilot.grants),
    plan: effectivePlan,
    maxFollowupAsks: agentCfg.strategy.max_followup_asks,
    summaryMaxChars: agentCfg.summary_max_chars,
    onStep: (sessionId, step) => runtime.emitStep(pr, sessionId, step),
    signal,
    autopilot,
  });
}
