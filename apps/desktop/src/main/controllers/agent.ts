import { loadAgentRules } from '@meebox/agent';
import {
  getAgentConversation,
  getAgentSession,
  getAgentTranscript,
  getAutopilotLedger,
} from '@meebox/poller';
import { pickMatchingRule } from '@meebox/rules';
import type { AgentRecommendationVerdict } from '@meebox/shared';
import { getContext } from '../services/context.js';
import type { IpcController } from './types.js';

/*
 * Agent 交互域 controllers：规则匹配 / 评审编排 / 自由规划 / 会话与台账读取
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
  return ctx.orchestrator.runPlanning(await ctx.pr.findPrOrThrow(req.localId), req.question);
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
