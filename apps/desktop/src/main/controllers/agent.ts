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
  listFileChangeDescriptions,
  listReviewRunsForPr,
} from '@meebox/poller';
import { pickMatchingRules } from '@meebox/rules';
import { AppError, CODEX_QUESTION_LIMIT, ERROR_CODES, type AgentRecommendationVerdict, type ReviewRun } from '@meebox/shared';
import { discoverCodexReview } from '../services/pr-agent/codex-review.js';
import { getCachedCodexModels, listCodexModels } from '../services/pr-agent/codex-models.js';
import { recoverPaddedReviewAnchors } from '../services/pr-agent/review-anchor.js';
import { getContext } from '../services/context.js';
import type { IpcController } from './types.js';
import { buildProxyEnv } from '../utils/proxy.js';

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
export const codexReviewStatus: IpcController<'codex:reviewStatus'> = async () => {
  const discovery = await discoverCodexReview();
  if (discovery.status === 'ready') {
    const ctx = getContext();
    void listCodexModels(
      ctx.stateStore,
      buildProxyEnv(ctx.bootstrap.config.proxy),
      discovery.runtime,
    ).catch(() => {});
  }
  return discovery.status;
};

async function readCodexCatalog() {
  const ctx = getContext();
  try {
    return await listCodexModels(ctx.stateStore, buildProxyEnv(ctx.bootstrap.config.proxy));
  } catch {
    throw new AppError(ERROR_CODES.AG_CODEX_MODEL_LIST_FAILED);
  }
}

export const codexModels: IpcController<'codex:models'> = (_event, req) =>
  req.cachedOnly ? getCachedCodexModels(getContext().stateStore) : readCodexCatalog();

export const listCodexRuns: IpcController<'codex:listRuns'> = async (_event, req) =>
  listReviewRunsForPr(await getContext().pr.storeForPr(req.localId), req.localId, { engine: 'codex' });

export const deleteCodexRun: IpcController<'codex:deleteRun'> = async (_event, req) => ({
  ok: await deleteReviewRun(await getContext().pr.storeForPr(req.localId), req.localId, req.runId, 'codex'),
});

export const cancelCodexRun: IpcController<'codex:cancel'> = (_event, req) =>
  getContext().runQueue.cancel(req.localId, req.runId, 'codex');

async function checkCodexModel(model?: string): Promise<string | undefined> {
  if (model === undefined) return;
  const cached = await getCachedCodexModels(getContext().stateStore);
  if (cached.some((entry) => entry.id === model)) return model;
  const models = await readCodexCatalog();
  if (!models.some((entry) => entry.id === model)) throw new AppError(ERROR_CODES.AG_CODEX_MODEL_UNAVAILABLE);
  return model;
}

export const runCodexReview: IpcController<'codex:review'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  return ctx.runQueue.enqueueCodexReview(pr, await checkCodexModel(req.model));
};

export const askCodex: IpcController<'codex:ask'> = async (_event, req) => {
  const question = typeof req.question === 'string' ? req.question.trim() : '';
  if (!question) throw new AppError(ERROR_CODES.AG_ASK_NEEDS_QUESTION);
  if (question.length > CODEX_QUESTION_LIMIT) {
    throw new AppError(ERROR_CODES.AG_CODEX_QUESTION_TOO_LONG, { limit: CODEX_QUESTION_LIMIT });
  }
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const model = await checkCodexModel(req.model);
  if (req.reference) {
    const run = await getReviewRun(await ctx.pr.storeForPr(req.localId), req.localId, req.reference.runId, 'codex');
    const finding = run?.findings?.find((f) => f.id === req.reference?.findingId);
    if (run?.engine !== 'codex' || run.tool !== 'review' || run.status !== 'succeeded' ||
        run.headSha !== pr.sourceRef.sha || run.baseSha !== pr.targetRef.sha || !finding) {
      throw new AppError(ERROR_CODES.AG_CODEX_REFERENCE_STALE);
    }
    return ctx.runQueue.enqueueCodexAsk(pr, question, { ...req.reference, anchor: finding.anchor }, model);
  }
  return ctx.runQueue.enqueueCodexAsk(pr, question, undefined, model);
};

export const cancelPragent: IpcController<'pragent:cancel'> = (_event, req) =>
  getContext().runQueue.cancel(req.localId, req.runId, 'pr-agent');

/**
 * Current queue snapshot (startup / reconnect fallback).
 */
export const getQueue: IpcController<'pragent:queue'> = () => getContext().runQueue.snapshot();

async function recoverRunAnchors(localId: string, runs: ReviewRun[]): Promise<ReviewRun[]> {
  const ctx = getContext();
  return recoverPaddedReviewAnchors(runs, async () => {
    const pr = await ctx.pr.findPrOrThrow(localId);
    return ctx.repoMirror.mirrorPath(ctx.pr.repoIdentityFor(pr));
  });
}

/**
 * List a PR's run history (cursor pagination).
 */
export const listRuns: IpcController<'pragent:listRuns'> = async (_event, req) => {
  const ctx = getContext();
  const runs = await listReviewRunsForPr(await ctx.pr.storeForPr(req.localId), req.localId, {
    limit: req.limit,
    beforeId: req.beforeId,
    engine: 'pr-agent',
  });
  return recoverRunAnchors(req.localId, runs);
};

export const fileChangeDescriptions: IpcController<'pragent:fileChangeDescriptions'> = async (
  _event,
  req,
) => {
  const store = await getContext().pr.storeForPr(req.localId);
  return listFileChangeDescriptions(store, req.localId, req);
};

/**
 * Query a single run.
 */
export const getRun: IpcController<'pragent:getRun'> = async (_event, req) => {
  const ctx = getContext();
  const run = await getReviewRun(await ctx.pr.storeForPr(req.localId), req.localId, req.runId, 'pr-agent');
  if (!run) return run;
  const [recovered] = await recoverRunAnchors(req.localId, [run]);
  return recovered ?? run;
};

/**
 * Clear PR Agent run history, session, and AutoPilot ledger for the PR.
 */
export const clearRuns: IpcController<'pragent:clearRuns'> = async (_event, req) => {
  const ctx = getContext();
  const store = await ctx.pr.storeForPr(req.localId);
  await clearAgentSession(store, req.localId);
  await clearAutopilotLedger(store, req.localId);
  ctx.broadcast('agent:reviewStatusCleared', { prLocalId: req.localId });
  const cleared = await clearReviewRunsForPr(store, req.localId);
  if (cleared) ctx.broadcast('pragent:fileChangeDescriptionsChanged', { localId: req.localId });
  return { cleared };
};

/**
 * Delete a single run record (only that run; leaves the Agent session / ledger / ★ badge untouched). The renderer optimistically removes it from the list.
 */
export const deleteRun: IpcController<'pragent:deleteRun'> = async (_event, req) => {
  const ctx = getContext();
  const ok = await deleteReviewRun(
    await ctx.pr.storeForPr(req.localId),
    req.localId,
    req.runId,
    'pr-agent',
  );
  if (ok) ctx.broadcast('pragent:fileChangeDescriptionsChanged', { localId: req.localId });
  return { ok };
};
