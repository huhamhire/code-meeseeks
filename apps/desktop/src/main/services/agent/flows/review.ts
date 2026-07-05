import { buildToolCatalog, DEFAULT_REVIEW_PLAN, loadAgentContext } from '@meebox/agent';
import type { AgentContext, ReviewPlan } from '@meebox/agent';
import { addFindingClosure } from '@meebox/poller';
import { combineRuleInstructions, pickMatchingRules } from '@meebox/rules';
import { AppError, ERROR_CODES, type AgentSession, type StoredPullRequest } from '@meebox/shared';
import { getMainLanguage } from '../../../i18n/index.js';
import { runReview } from '../review.js';
import type { AgentChat, OrchestratorRuntime } from '../runtime.js';
import { planningFlow } from './planning.js';

/**
 * Manual review orchestration (agent:run): assemble context on demand + register AbortController + mark running,
 * run the review micro-flow, and at the end persist the "review summary" to the conversation and ledger. The review
 * micro-flow is a fixed template and cannot be redirected mid-run: after it finishes, the user messages queued during
 * the run are handled as a follow-up free-planning round (fire-and-forget; this review session returns as usual).
 */
export async function reviewFlow(
  runtime: OrchestratorRuntime,
  pr: StoredPullRequest,
): Promise<AgentSession> {
  const { getPrAgentBridge, ensureAgentDir, logger } = runtime.ctx;
  if (!getPrAgentBridge()) throw new AppError(ERROR_CODES.AG_PR_AGENT_NOT_READY);
  // Assemble the Agent context on demand (SOUL/AGENTS/MEMORY/USER + rules), no cache; ensure the directory is initialized before loading.
  const agentContext = await loadAgentContext(await ensureAgentDir(), {
    onWarn: (msg, file) => logger.warn({ file }, `agent context: ${msg}`),
  });
  // Register the AbortController so the stop button (agent:stop) can immediately abort this review at any thinking / execution phase.
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
    // The wrap-up summary is added to the conversation (assistant review message) → UI renders the "review summary" card.
    await runtime.recordReviewSummaryMessage(pr, session);
  } finally {
    runtime.clearController(pr.localId);
    runtime.unmarkRunning(pr.localId);
  }
  // The review micro-flow cannot be redirected mid-run: after it finishes, the queued user messages are handled as a follow-up free-planning round (fire-and-forget).
  const pending = runtime.takePending(pr.localId);
  if (pending.length) {
    void planningFlow(runtime, pr, pending.join('\n\n')).catch((err: unknown) => {
      logger.warn({ err, prLocalId: pr.localId }, 'post-review planning (queued input) failed');
    });
  }
  return session;
}

/**
 * Run the review micro-flow for a PR (shared enqueue queue / persistence / step broadcast). Shared by manual review
 * and AutoPilot background review.
 * Runs dispatched by the orchestration use the agent low-priority lane; modifying tools are gated by grants (red line see buildToolCatalog).
 */
export async function runReviewForPr(
  runtime: OrchestratorRuntime,
  pr: StoredPullRequest,
  agentContext: AgentContext,
  chat: AgentChat,
  signal?: AbortSignal,
  autopilot = false,
  /** Review execution plan (only injected by AutoPilot per rules); omitted → micro-flow uses the default full set. */
  plan?: ReviewPlan,
): Promise<AgentSession> {
  const agentCfg = runtime.ctx.bootstrap.config.agent;
  // per-PR storage routing: when re-running review on an archived (closed-scope) PR, the conversation / run / closure relations all go to archive cold storage.
  const store = await runtime.ctx.pr.storeForPr(pr.localId);
  // Auto follow-up off: the review micro-flow skips judge + asks (no interpretation, no conditional follow-up ask) and
  // summarizes directly — saving one judge LLM call and the potential follow-up ask cost. Covers both sources: the default plan and the AutoPilot rule-injected plan.
  const effectivePlan: ReviewPlan | undefined = agentCfg.strategy.auto_followup
    ? plan
    : {
        steps: (plan ?? DEFAULT_REVIEW_PLAN).steps.filter((k) => k !== 'judge' && k !== 'asks'),
      };
  const matchedRules = pickMatchingRules(agentContext.rules, {
    projectKey: pr.repo.projectKey,
    repoSlug: pr.repo.repoSlug,
    targetBranch: pr.targetRef.displayId,
    tool: 'review',
  });
  runtime.ctx.logger.info(
    {
      localId: pr.localId,
      rulesLoaded: agentContext.rules.length,
      rulesMatched: matchedRules.length,
      ruleIds: matchedRules.map((r) => r.id),
    },
    'agent review: rules',
  );
  return runReview(pr, {
    stateStore: store,
    // Runs dispatched by the orchestration use the agent low-priority lane: a user clicking /review at any time jumps ahead of them. Re-review /ask carries the referenced context + forward chain.
    enqueueRun: (p, tool, question, referencedContext, referencedFinding) =>
      runtime.runQueue.enqueuePragentRun(
        p,
        tool,
        question,
        'agent',
        referencedContext,
        referencedFinding,
      ),
    // Re-review verdict replace/drop → close the superseded original review finding (write FindingClosure + broadcast a card refresh).
    closeFinding: async (p, call) => {
      await addFindingClosure(store, p.localId, call);
      runtime.ctx.broadcast('findingClosures:changed', { localId: p.localId });
    },
    chat,
    agentContext,
    matchedRuleInstructions: combineRuleInstructions(matchedRules),
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
