import { appendAgentNotes, buildToolCatalog, loadAgentContext } from '@meebox/agent';
import type { AgentContext } from '@meebox/agent';
import { appendAgentMessage, updateAgentSession } from '@meebox/poller';
import { combineRuleInstructions, pickMatchingRules } from '@meebox/rules';
import { AppError, ERROR_CODES, type AgentSession, type StoredPullRequest } from '@meebox/shared';
import { getMainLanguage } from '../../../i18n/index.js';
import { runPlanning } from '../planning.js';
import type { AgentChat, OrchestratorRuntime } from '../runtime.js';

/** Free planning orchestration (agent:ask): assemble context on demand + register AbortController + mark running, then run the planning ReAct. */
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
  // Do not log the user input body (avoid leakage / flooding): log only the initiation itself; the input is already persisted to the conversation.
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

/** Run free planning for a PR (assemble PlanningDeps + call the runner): includes mid-run input drain, plan persistence, and proactive memory persistence. */
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
  // per-PR storage routing: conversation / plan for archived (closed-scope) PRs go to archive cold storage, not polluting active storage.
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
    // /ask budget: in free planning each consecutive /ask is one agentic exploration and costly, capped by the
    // configured "follow-up ask count" (unrelated to the "auto follow-up" switch — the switch only constrains the
    // review micro-flow; this always applies, following the configured follow-up ask cap).
    maxFollowupAsks: agentCfg.strategy.max_followup_asks,
    signal,
    onStep: (sessionId, step) => runtime.emitStep(pr, sessionId, step),
    // Mid-run input redirection: each round the planner pulls queued messages and here persists them to the
    // conversation + broadcasts a refresh (instantly shown as user bubbles), then the planner merges them into the
    // current round's progress and re-plans the next step per the latest instructions.
    drainPendingInput: async () => {
      const msgs = runtime.takePending(pr.localId);
      for (const m of msgs) {
        await appendAgentMessage(store, pr.localId, { role: 'user', content: m });
      }
      if (msgs.length) runtime.ctx.broadcast('agent:conversationChanged', { prLocalId: pr.localId });
      return msgs;
    },
    // Plan (todo) update: once the planner provides a plan, persist it to the conversation + broadcast a refresh of
    // the plan panel; hydrated via agent:getSession on PR switch / restart.
    recordPlan: async (todo) => {
      await updateAgentSession(store, pr.localId, { todo });
      runtime.ctx.broadcast('agent:planUpdated', { prLocalId: pr.localId, todo });
    },
    // Persist the non-private entries the Agent proactively noted to each writable file in the current Agent
    // directory (USER/MEMORY/AGENTS); SOUL.md is never written. The next loadAgentContext reads it live (cross-session memory).
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
