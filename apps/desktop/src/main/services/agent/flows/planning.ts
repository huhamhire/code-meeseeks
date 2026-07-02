import { appendAgentNotes, buildToolCatalog, loadAgentContext } from '@meebox/agent';
import type { AgentContext } from '@meebox/agent';
import { appendAgentMessage, updateAgentSession } from '@meebox/poller';
import { combineRuleInstructions, pickMatchingRules } from '@meebox/rules';
import { AppError, ERROR_CODES, type AgentSession, type StoredPullRequest } from '@meebox/shared';
import { getMainLanguage } from '../../../i18n/index.js';
import { runPlanning } from '../planning.js';
import type { AgentChat, OrchestratorRuntime } from '../runtime.js';

/** 自由规划编排（agent:ask）：现读现装配上下文 + 注册 AbortController + 标记执行中，跑规划 ReAct。 */
export async function planningFlow(
  runtime: OrchestratorRuntime,
  pr: StoredPullRequest,
  question: string,
  referencedContext?: string,
): Promise<AgentSession> {
  const { getPrAgentBridge, ensureAgentDir, logger } = runtime.ctx;
  if (!getPrAgentBridge()) throw new AppError(ERROR_CODES.AG_PR_AGENT_NOT_READY);
  const agentContext = await loadAgentContext(await ensureAgentDir(), {
    onWarn: (msg, file) => logger.warn({ file }, `agent context: ${msg}`),
  });
  const ac = new AbortController();
  runtime.registerController(pr.localId, ac);
  runtime.markRunning(pr.localId);
  // 不记用户输入正文（避免泄漏 / 刷屏）：只记发起本身，输入已落多轮对话。
  logger.info({ prLocalId: pr.localId }, 'agent chat start (planning)');
  try {
    const session = await runtime.withAgentChat(
      (chat) => runPlanningForPr(runtime,pr, question, agentContext, chat, ac.signal, referencedContext),
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
    runtime.clearController(pr.localId);
    runtime.unmarkRunning(pr.localId);
  }
}

/** 对一个 PR 跑自由规划（组装 PlanningDeps + 调 runner）：含中途输入 drain、计划持久化、主动记忆落盘。 */
export async function runPlanningForPr(
  runtime: OrchestratorRuntime,
  pr: StoredPullRequest,
  userRequest: string,
  agentContext: AgentContext,
  chat: AgentChat,
  signal: AbortSignal,
  referencedContext?: string,
): Promise<AgentSession> {
  const { bootstrap, effectiveAgentDir, logger } = runtime.ctx;
  const agentCfg = bootstrap.config.agent;
  // per-PR 存储路由：已归档（已关闭范围）PR 上的对话 / 计划落归档冷存储，不污染活跃存储。
  const store = await runtime.ctx.pr.storeForPr(pr.localId);
  const matchedRules = pickMatchingRules(agentContext.rules, {
    projectKey: pr.repo.projectKey,
    repoSlug: pr.repo.repoSlug,
    targetBranch: pr.targetRef.displayId,
    tool: 'review',
  });
  logger.info(
    {
      localId: pr.localId,
      rulesLoaded: agentContext.rules.length,
      rulesMatched: matchedRules.length,
      ruleIds: matchedRules.map((r) => r.id),
    },
    'agent planning: rules',
  );
  return runPlanning(pr, userRequest, {
    stateStore: store,
    enqueueRun: (p, tool, question) => runtime.runQueue.enqueuePragentRun(p, tool, question, 'agent'),
    referencedContext,
    chat,
    agentContext,
    toolCatalog: buildToolCatalog(agentCfg.autopilot.grants),
    matchedRuleInstructions: combineRuleInstructions(matchedRules),
    language: getMainLanguage(),
    maxSteps: agentCfg.max_steps,
    // /ask 预算：自由规划里连续 /ask 各为一次 agentic 探索、成本高，按配置「追问数量」封顶（与「自动追问」
    // 开关无关——开关仅约束评审微流程；此处始终生效，遵循配置的追问数量上限）。
    maxFollowupAsks: agentCfg.strategy.max_followup_asks,
    signal,
    onStep: (sessionId, step) => runtime.emitStep(pr, sessionId, step),
    // 中途输入转向：planner 每轮取出排队消息时在此落盘进会话 + 广播刷新（即时显示为用户气泡），
    // planner 再把它们并入当轮 progress、据最新指令重排下一步。
    drainPendingInput: async () => {
      const msgs = runtime.takePending(pr.localId);
      for (const m of msgs) {
        await appendAgentMessage(store, pr.localId, { role: 'user', content: m });
      }
      if (msgs.length) runtime.ctx.broadcast('agent:conversationChanged', { prLocalId: pr.localId });
      return msgs;
    },
    // 计划（todo）更新：planner 给出 plan 即持久化进会话 + 广播刷新计划面板；切 PR / 重启经
    // agent:getSession 水合。
    recordPlan: async (todo) => {
      await updateAgentSession(store, pr.localId, { todo });
      runtime.ctx.broadcast('agent:planUpdated', { prLocalId: pr.localId, todo });
    },
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
