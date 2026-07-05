import { loadAgentRules } from '@meebox/agent';
import {
  clearAgentSession,
  clearAutopilotLedger,
  clearReviewRunsForPr,
  deleteReviewRun,
  getAgentConversation,
  getAgentSession,
  getAgentTranscript,
  getAutopilotLedger,
  getReviewRun,
  listReviewRunsForPr,
} from '@meebox/poller';
import { pickMatchingRules } from '@meebox/rules';
import { AppError, ERROR_CODES, type AgentRecommendationVerdict } from '@meebox/shared';
import { getContext } from '../services/context.js';
import type { IpcController } from './types.js';

/*
 * Agent interaction-domain controllers: rule matching / review orchestration / free planning / session and ledger reads / pr-agent run queue
 */

/**
 * Look up the rules a PR currently matches (the ask tool takes no rules; returns null on no match).
 */
export const matchRuleForPr: IpcController<'rules:matchForPr'> = async (_event, req) => {
  if (req.tool === 'ask') return [];
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const rules = await loadAgentRules(await ctx.ensureAgentDir(), {
    onWarn: (msg, file) => ctx.logger.warn({ file }, `rules: ${msg}`),
  });
  const matched = pickMatchingRules(rules, {
    projectKey: pr.repo.projectKey,
    repoSlug: pr.repo.repoSlug,
    targetBranch: pr.targetRef.displayId,
    tool: req.tool,
  });
  return matched.map((m) => ({
    id: m.id,
    filePath: m.filePath,
    priority: m.priority,
    tools: [...m.tools],
    instructions: m.instructions,
  }));
};

/**
 * Review micro-flow (describe→review→conditional follow-up→summary), finishing by writing the "review summary".
 */
export const runReview: IpcController<'agent:run'> = async (_event, req) => {
  const ctx = getContext();
  return ctx.orchestrator.runReview(await ctx.pr.findPrOrThrow(req.localId));
};

/**
 * Free-planning Agent (natural-language "conversation as delegation").
 */
export const runPlanning: IpcController<'agent:ask'> = async (_event, req) => {
  const ctx = getContext();
  return ctx.orchestrator.runPlanning(
    await ctx.pr.findPrOrThrow(req.localId),
    req.question,
    req.referencedContext,
  );
};

/**
 * Append a user message during a run: if an Agent is running, enqueue it (merged into the reorder next cycle); otherwise start a free-planning round as fallback.
 */
export const enqueueMessage: IpcController<'agent:enqueueMessage'> = async (_event, req) => {
  const ctx = getContext();
  return ctx.orchestrator.enqueueMessage(await ctx.pr.findPrOrThrow(req.localId), req.message);
};

/**
 * Pause a PR's Agent run (immediate abort at any thinking / execution stage).
 */
export const stopAgent: IpcController<'agent:stop'> = (_event, req) =>
  getContext().orchestrator.stop(req.localId);

/**
 * Read a given PR's persisted Agent session (restored across PR switches and restarts).
 */
export const getSession: IpcController<'agent:getSession'> = async (_event, req) => {
  const ctx = getContext();
  return getAgentSession(await ctx.pr.storeForPr(req.localId), req.localId);
};

/**
 * Read a given PR's multi-turn conversation messages.
 */
export const getConversation: IpcController<'agent:getConversation'> = async (_event, req) => {
  const ctx = getContext();
  return getAgentConversation(await ctx.pr.storeForPr(req.localId), req.localId);
};

/**
 * Read a given PR's Agent process steps (transcript).
 */
export const getTranscript: IpcController<'agent:getTranscript'> = async (_event, req) => {
  const ctx = getContext();
  return getAgentTranscript(await ctx.pr.storeForPr(req.localId), req.localId);
};

/**
 * Batch-read AutoPilot ledgers: return only recommendation where decision=review and a recommender exists (used for PR list badges).
 */
export const getAutopilotLedgers: IpcController<'agent:autopilotLedgers'> = async (_event, req) => {
  const ctx = getContext();
  const out: Record<string, AgentRecommendationVerdict> = {};
  for (const id of req.localIds) {
    // Ledger badges for the closed-PR list must be read from archive storage (their ledgers move into cold storage along with the PR tree).
    const ledger = await getAutopilotLedger(await ctx.pr.storeForPr(id), id);
    if (ledger?.decision === 'review' && ledger.recommendation) {
      out[id] = ledger.recommendation;
    }
  }
  return out;
};

/*
 * pr-agent run queue (review-tool execution layer; agent:run / AutoPilot and user manual runs share the same queue)
 */

/**
 * Trigger one run (queue-scheduled). /ask must carry a question; validate early to avoid erroring only after queuing.
 */
export const runPragent: IpcController<'pragent:run'> = async (_event, req) => {
  const ctx = getContext();
  if (!ctx.getPrAgentBridge()) {
    throw new AppError(ERROR_CODES.AG_PR_AGENT_NOT_READY);
  }
  if (req.tool === 'ask' && !req.question?.trim()) {
    throw new AppError(ERROR_CODES.AG_ASK_NEEDS_QUESTION);
  }
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  return ctx.runQueue.enqueuePragentRun(
    pr,
    req.tool,
    req.question,
    'user',
    req.referencedContext,
    req.referencedFinding,
    req.scope,
  );
};

/**
 * Cancel a run (active SIGKILL / waiting dequeue).
 */
export const cancelPragent: IpcController<'pragent:cancel'> = (_event, req) =>
  getContext().runQueue.cancel(req.runId);

/**
 * Current queue snapshot (startup / reconnect fallback).
 */
export const getQueue: IpcController<'pragent:queue'> = () => getContext().runQueue.snapshot();

/**
 * List a PR's run history (cursor pagination).
 */
export const listRuns: IpcController<'pragent:listRuns'> = async (_event, req) => {
  const ctx = getContext();
  return listReviewRunsForPr(await ctx.pr.storeForPr(req.localId), req.localId, {
    limit: req.limit,
    beforeId: req.beforeId,
  });
};

/**
 * Query a single run.
 */
export const getRun: IpcController<'pragent:getRun'> = async (_event, req) => {
  const ctx = getContext();
  return getReviewRun(await ctx.pr.storeForPr(req.localId), req.localId, req.runId);
};

/**
 * Clear all of a PR's run history, and clear the Agent session + AutoPilot ledger together (broadcast so the ★ badge disappears immediately).
 */
export const clearRuns: IpcController<'pragent:clearRuns'> = async (_event, req) => {
  const ctx = getContext();
  const store = await ctx.pr.storeForPr(req.localId);
  await clearAgentSession(store, req.localId);
  await clearAutopilotLedger(store, req.localId);
  ctx.broadcast('agent:reviewStatusCleared', { prLocalId: req.localId });
  return { cleared: await clearReviewRunsForPr(store, req.localId) };
};

/**
 * Delete a single run record (only that run; leaves the Agent session / ledger / ★ badge untouched). The renderer optimistically removes it from the list.
 */
export const deleteRun: IpcController<'pragent:deleteRun'> = async (_event, req) => {
  const ctx = getContext();
  return { ok: await deleteReviewRun(await ctx.pr.storeForPr(req.localId), req.localId, req.runId) };
};
