import { ERROR_CODES, type ReviewRunTool } from '@meebox/shared';
import * as agentCtl from '../../../controllers/agent.js';
import { HttpError } from '../http.js';
import { toPrAgentRuns } from '../views.js';
import { NO_EVENT, seg, type Route, type RouteHandler } from './shared.js';

/**
 * Review agent domain endpoints: status / conversation (browsing), auto review / instruct / chat / stop
 * (write-type, reusing the existing run queue), plus per-run discovery and cancellation. Agent `instruct`
 * is **read-only tools only**; mutating tools (publish, etc.) are hard-rejected at the API layer.
 */

/** Read-only Agent instructions the API allows (matching the tool registry's isRun read-only family; write tools are excluded). */
const READ_ONLY_TOOLS: ReadonlySet<ReviewRunTool> = new Set([
  'describe',
  'review',
  'ask',
  'improve',
]);

const agentStatus: RouteHandler = ({ params }) =>
  agentCtl.getSession(NO_EVENT, { localId: params.id });

const agentHistory: RouteHandler = ({ params }) =>
  agentCtl.getConversation(NO_EVENT, { localId: params.id });

const agentReview: RouteHandler = ({ params }) => agentCtl.runReview(NO_EVENT, { localId: params.id });

/** Send a read-only Agent instruction (describe / review / ask / improve); write tools hard-rejected (403), no confirmation. */
const agentInstruct: RouteHandler = ({ params, body }) => {
  const b = (body ?? {}) as { command?: string; args?: string };
  const command = (b.command ?? '').replace(/^\//, '') as ReviewRunTool;
  if (!READ_ONLY_TOOLS.has(command)) {
    throw new HttpError(403, ERROR_CODES.SV_WRITE_NOT_ALLOWED, { command: b.command ?? '' });
  }
  if (command === 'ask' && !b.args?.trim()) {
    throw new HttpError(400, ERROR_CODES.SV_BAD_REQUEST, { reason: 'ask requires args' });
  }
  return agentCtl.runPragent(NO_EVENT, { localId: params.id, tool: command, question: b.args });
};

/** Send a natural-language chat (may trigger an Agent task): enqueue if running, otherwise start a free-planning fallback round. */
const agentChat: RouteHandler = ({ params, body }) => {
  const b = (body ?? {}) as { message?: string };
  if (!b.message?.trim()) {
    throw new HttpError(400, ERROR_CODES.SV_BAD_REQUEST, { reason: 'message required' });
  }
  return agentCtl.enqueueMessage(NO_EVENT, { localId: params.id, message: b.message });
};

/** Stop the Agent currently running on this PR (immediate stop at any thinking / execution stage). PR-level stop, not per-tool run. */
const agentStop: RouteHandler = ({ params }) =>
  agentCtl.stopAgent(NO_EVENT, { localId: params.id });

/** This PR's pr-agent runs in the run queue (active + waiting), for discovery before per-run cancellation. */
const agentRuns: RouteHandler = async ({ params }) => {
  const snapshot = await agentCtl.getQueue(NO_EVENT, undefined);
  return toPrAgentRuns(snapshot, params.id);
};

/** Cancel one of this PR's pr-agent runs (active SIGKILL / waiting dequeue). Validate the run belongs to this PR first. */
const agentRunCancel: RouteHandler = async ({ params }) => {
  const snapshot = await agentCtl.getQueue(NO_EVENT, undefined);
  const belongs = [...snapshot.active, ...snapshot.waiting].some(
    (r) => r.runId === params.runId && r.prLocalId === params.id,
  );
  if (!belongs) {
    throw new HttpError(404, ERROR_CODES.SV_NOT_FOUND, { runId: params.runId, localId: params.id });
  }
  return agentCtl.cancelPragent(NO_EVENT, { runId: params.runId });
};

export const agentRoutes: Route[] = [
  { method: 'GET', segments: seg('/api/v1/prs/:id/agent'), handler: agentStatus },
  { method: 'GET', segments: seg('/api/v1/prs/:id/agent/conversation'), handler: agentHistory },
  { method: 'POST', segments: seg('/api/v1/prs/:id/agent/review'), handler: agentReview },
  { method: 'POST', segments: seg('/api/v1/prs/:id/agent/instruct'), handler: agentInstruct },
  { method: 'POST', segments: seg('/api/v1/prs/:id/agent/chat'), handler: agentChat },
  { method: 'POST', segments: seg('/api/v1/prs/:id/agent/stop'), handler: agentStop },
  { method: 'GET', segments: seg('/api/v1/prs/:id/agent/runs'), handler: agentRuns },
  {
    method: 'POST',
    segments: seg('/api/v1/prs/:id/agent/runs/:runId/cancel'),
    handler: agentRunCancel,
  },
];
