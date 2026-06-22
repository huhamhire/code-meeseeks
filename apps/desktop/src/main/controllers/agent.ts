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
import { pickMatchingRule } from '@meebox/rules';
import { AppError, ERROR_CODES, type AgentRecommendationVerdict } from '@meebox/shared';
import { getContext } from '../services/context.js';
import type { IpcController } from './types.js';

/*
 * Agent 交互域 controllers：规则匹配 / 评审编排 / 自由规划 / 会话与台账读取 / pr-agent run 队列
 */

/**
 * 查 PR 当前命中的规则（ask 工具不接规则；无命中回 null）。
 */
export const matchRuleForPr: IpcController<'rules:matchForPr'> = async (_event, req) => {
  if (req.tool === 'ask') return null;
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const rules = await loadAgentRules(ctx.effectiveAgentDir(), {
    onWarn: (msg, file) => ctx.logger.warn({ file }, `rules: ${msg}`),
  });
  const matched = pickMatchingRule(rules, {
    projectKey: pr.repo.projectKey,
    repoSlug: pr.repo.repoSlug,
    targetBranch: pr.targetRef.displayId,
    tool: req.tool,
  });
  if (!matched) return null;
  return {
    id: matched.id,
    filePath: matched.filePath,
    priority: matched.priority,
    tools: [...matched.tools],
    instructions: matched.instructions,
  };
};

/**
 * 评审微流程（describe→review→条件追问→总结），收尾落「评审总结」。
 */
export const runReview: IpcController<'agent:run'> = async (_event, req) => {
  const ctx = getContext();
  return ctx.orchestrator.runReview(await ctx.pr.findPrOrThrow(req.localId));
};

/**
 * 自由规划 Agent（自然语言「对话即委派」）。
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
 * 运行期间追加一条用户消息：有 Agent 在跑则入队（下一周期并入重排），否则起一轮自由规划兜底。
 */
export const enqueueMessage: IpcController<'agent:enqueueMessage'> = async (_event, req) => {
  const ctx = getContext();
  return ctx.orchestrator.enqueueMessage(await ctx.pr.findPrOrThrow(req.localId), req.message);
};

/**
 * 暂停某 PR 的 Agent 运行（思考 / 执行任意阶段即时中止）。
 */
export const stopAgent: IpcController<'agent:stop'> = (_event, req) =>
  getContext().orchestrator.stop(req.localId);

/**
 * 读指定 PR 已落盘的 Agent 会话（跨 PR 切换、重启后恢复）。
 */
export const getSession: IpcController<'agent:getSession'> = (_event, req) =>
  getAgentSession(getContext().stateStore, req.localId);

/**
 * 读指定 PR 的多轮对话消息。
 */
export const getConversation: IpcController<'agent:getConversation'> = (_event, req) =>
  getAgentConversation(getContext().stateStore, req.localId);

/**
 * 读指定 PR 的 Agent 过程步骤（transcript）。
 */
export const getTranscript: IpcController<'agent:getTranscript'> = (_event, req) =>
  getAgentTranscript(getContext().stateStore, req.localId);

/**
 * 批量读 AutoPilot 台账：仅返回 decision=review 且有建议者的 recommendation（PR 列表徽标用）。
 */
export const getAutopilotLedgers: IpcController<'agent:autopilotLedgers'> = async (_event, req) => {
  const { stateStore } = getContext();
  const out: Record<string, AgentRecommendationVerdict> = {};
  for (const id of req.localIds) {
    const ledger = await getAutopilotLedger(stateStore, id);
    if (ledger?.decision === 'review' && ledger.recommendation) {
      out[id] = ledger.recommendation;
    }
  }
  return out;
};

/*
 * pr-agent run 队列（评审工具执行层；agent:run / AutoPilot 与用户手动 run 共用同一队列）
 */

/**
 * 触发一次 run（队列调度）。/ask 必须带 question，提前校验避免排队后才报错。
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
  return ctx.runQueue.enqueuePragentRun(pr, req.tool, req.question, 'user', req.referencedContext);
};

/**
 * 取消一个 run（active SIGKILL / waiting 出队）。
 */
export const cancelPragent: IpcController<'pragent:cancel'> = (_event, req) =>
  getContext().runQueue.cancel(req.runId);

/**
 * 当前队列快照（启动 / 重连兜底）。
 */
export const getQueue: IpcController<'pragent:queue'> = () => getContext().runQueue.snapshot();

/**
 * 列某 PR 历史 run（游标分页）。
 */
export const listRuns: IpcController<'pragent:listRuns'> = (_event, req) =>
  listReviewRunsForPr(getContext().stateStore, req.localId, {
    limit: req.limit,
    beforeId: req.beforeId,
  });

/**
 * 单条 run 查询。
 */
export const getRun: IpcController<'pragent:getRun'> = (_event, req) =>
  getReviewRun(getContext().stateStore, req.localId, req.runId);

/**
 * 清某 PR 全部 run 历史，并一并清 Agent 会话 + AutoPilot 台账（广播 ★ 徽标即时消失）。
 */
export const clearRuns: IpcController<'pragent:clearRuns'> = async (_event, req) => {
  const ctx = getContext();
  await clearAgentSession(ctx.stateStore, req.localId);
  await clearAutopilotLedger(ctx.stateStore, req.localId);
  ctx.broadcast('agent:reviewStatusCleared', { prLocalId: req.localId });
  return { cleared: await clearReviewRunsForPr(ctx.stateStore, req.localId) };
};

/**
 * 删除单条 run 记录（仅该 run，不动 Agent 会话 / 台账 / ★ 徽标）。renderer 乐观从列表移除。
 */
export const deleteRun: IpcController<'pragent:deleteRun'> = async (_event, req) => {
  return { ok: await deleteReviewRun(getContext().stateStore, req.localId, req.runId) };
};
