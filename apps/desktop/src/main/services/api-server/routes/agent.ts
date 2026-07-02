import { ERROR_CODES, type ReviewRunTool } from '@meebox/shared';
import * as agentCtl from '../../../controllers/agent.js';
import { HttpError } from '../http.js';
import { toPrAgentRuns } from '../views.js';
import { NO_EVENT, seg, type Route, type RouteHandler } from './shared.js';

/**
 * 评审 Agent 领域端点：状态 / 会话（浏览），auto review / 指令 / 聊天 / 中断（写入型，复用既有 run 队列），
 * 以及按 run 的发现与取消。Agent `instruct` **仅只读工具**，变更类工具（publish 等）在 API 层硬拒绝。
 */

/** API 仅允许的只读 Agent 指令（与工具注册表 isRun 只读族一致；写工具不在此列）。 */
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

/** 发送只读 Agent 指令（describe / review / ask / improve）；写工具硬拒绝（403），无二次确认。 */
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

/** 发送自然语言聊天（可触发 Agent 任务）：运行中入队、否则起一轮自由规划兜底。 */
const agentChat: RouteHandler = ({ params, body }) => {
  const b = (body ?? {}) as { message?: string };
  if (!b.message?.trim()) {
    throw new HttpError(400, ERROR_CODES.SV_BAD_REQUEST, { reason: 'message required' });
  }
  return agentCtl.enqueueMessage(NO_EVENT, { localId: params.id, message: b.message });
};

/** 中断该 PR 正在运行的 Agent（思考 / 执行任意阶段即时停）。PR 级停，非按单个工具 run。 */
const agentStop: RouteHandler = ({ params }) =>
  agentCtl.stopAgent(NO_EVENT, { localId: params.id });

/** 该 PR 在运行队列里的 pr-agent runs（active + waiting），供按 run 取消前的发现。 */
const agentRuns: RouteHandler = async ({ params }) => {
  const snapshot = await agentCtl.getQueue(NO_EVENT, undefined);
  return toPrAgentRuns(snapshot, params.id);
};

/** 取消该 PR 的某个 pr-agent run（active SIGKILL / waiting 出队）。先校验 run 归属该 PR。 */
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
