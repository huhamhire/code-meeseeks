import { ipcMain } from 'electron';
import { loadAgentRules } from '@meebox/agent';
import type { IpcChannels } from '@meebox/ipc';
import {
  getAgentConversation,
  getAgentSession,
  getAgentTranscript,
  getAutopilotLedger,
} from '@meebox/poller';
import { pickMatchingRule } from '@meebox/rules';
import type { AgentRecommendationVerdict } from '@meebox/shared';
import type { AgentOrchestratorService } from '../agent-orchestrator.js';
import type { IpcContext } from '../context.js';

/** Agent 交互域：规则匹配 / 评审编排 / 自由规划 / 会话与台账读取。 */
export function registerAgentHandlers(
  ctx: IpcContext,
  orchestrator: AgentOrchestratorService,
): void {
  const { logger, stateStore, findPrOrThrow, effectiveAgentDir } = ctx;

  ipcMain.handle(
    'rules:matchForPr',
    async (
      _evt,
      req: IpcChannels['rules:matchForPr']['request'],
    ): Promise<IpcChannels['rules:matchForPr']['response']> => {
      // ask 工具不接规则 (问答自由形式，没什么"规约"可应用)
      if (req.tool === 'ask') return null;
      const pr = await findPrOrThrow(req.localId);
      const rules = await loadAgentRules(effectiveAgentDir(), {
        onWarn: (msg, file) => logger.warn({ file }, `rules: ${msg}`),
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
    },
  );

  ipcMain.handle(
    'agent:run',
    async (
      _evt,
      req: IpcChannels['agent:run']['request'],
    ): Promise<IpcChannels['agent:run']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      return orchestrator.runReview(pr);
    },
  );

  ipcMain.handle(
    'agent:ask',
    async (
      _evt,
      req: IpcChannels['agent:ask']['request'],
    ): Promise<IpcChannels['agent:ask']['response']> => {
      const pr = await findPrOrThrow(req.localId);
      return orchestrator.runPlanning(pr, req.question);
    },
  );

  ipcMain.handle(
    'agent:stop',
    (_evt, req: IpcChannels['agent:stop']['request']): IpcChannels['agent:stop']['response'] =>
      orchestrator.stop(req.localId),
  );

  ipcMain.handle(
    'agent:getSession',
    async (
      _evt,
      req: IpcChannels['agent:getSession']['request'],
    ): Promise<IpcChannels['agent:getSession']['response']> =>
      getAgentSession(stateStore, req.localId),
  );

  ipcMain.handle(
    'agent:getConversation',
    async (
      _evt,
      req: IpcChannels['agent:getConversation']['request'],
    ): Promise<IpcChannels['agent:getConversation']['response']> =>
      getAgentConversation(stateStore, req.localId),
  );

  ipcMain.handle(
    'agent:getTranscript',
    async (
      _evt,
      req: IpcChannels['agent:getTranscript']['request'],
    ): Promise<IpcChannels['agent:getTranscript']['response']> =>
      getAgentTranscript(stateStore, req.localId),
  );

  ipcMain.handle(
    'agent:autopilotLedgers',
    async (
      _evt,
      req: IpcChannels['agent:autopilotLedgers']['request'],
    ): Promise<IpcChannels['agent:autopilotLedgers']['response']> => {
      const out: Record<string, AgentRecommendationVerdict> = {};
      for (const id of req.localIds) {
        const ledger = await getAutopilotLedger(stateStore, id);
        if (ledger?.decision === 'review' && ledger.recommendation) {
          out[id] = ledger.recommendation;
        }
      }
      return out;
    },
  );
}
