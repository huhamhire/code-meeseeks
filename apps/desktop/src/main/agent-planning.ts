import { runPlanningAgent, type AgentContext, type PlanningToolResult } from '@meebox/agent';
import { appendAgentStep, startAgentSession, updateAgentSession } from '@meebox/poller';
import type { Rule } from '@meebox/rules';
import type {
  AgentSession,
  AgentStep,
  ReviewRun,
  StoredPullRequest,
  ToolCatalogEntry,
} from '@meebox/shared';
import type { StateStore } from '@meebox/state-store';

/**
 * 把自由规划编排器（runPlanningAgent）接到主进程：自然语言入口的「对话即委派」。
 * runTool 把读类工具映射到既有 pr-agent 运行队列；红线由编排器经 assertToolAllowed 把关。
 * signal 支持用户暂停（Stop）；暂停 → 会话置 paused 保态。
 */

const STDOUT_LOG_SEP = '\n\n---\n[pr-agent stdout log]\n';
function reviewRunText(run: ReviewRun): string {
  return (run.stdout ?? '').split(STDOUT_LOG_SEP)[0]?.trim() ?? '';
}

const READ_TOOLS = new Set(['describe', 'review', 'ask']);

export interface AgentPlanningDeps {
  stateStore: StateStore;
  enqueueRun: (
    pr: StoredPullRequest,
    tool: 'describe' | 'review' | 'ask',
    question?: string,
  ) => Promise<ReviewRun>;
  chat: (input: { system: string; user: string }) => Promise<PlanningToolResult>;
  agentContext: AgentContext;
  toolCatalog: ToolCatalogEntry[];
  matchedRule?: Rule | null;
  language: string;
  maxSteps: number;
  signal?: AbortSignal;
  onStep?: (sessionId: string, step: AgentStep) => void;
}

export async function runAgentPlanning(
  pr: StoredPullRequest,
  userRequest: string,
  deps: AgentPlanningDeps,
  now: () => Date = () => new Date(),
): Promise<AgentSession> {
  const session = await startAgentSession(
    deps.stateStore,
    { prLocalId: pr.localId, maxSteps: deps.maxSteps, userRequest },
    now,
  );

  try {
    const result = await runPlanningAgent(
      {
        chat: deps.chat,
        runTool: async ({ tool, question }) => {
          const bare = tool.replace(/^\//, '');
          if (!READ_TOOLS.has(bare)) throw new Error(`不支持的工具：${tool}`);
          const run = await deps.enqueueRun(pr, bare as 'describe' | 'review' | 'ask', question);
          if (run.status !== 'succeeded') {
            throw new Error(`pr-agent ${bare} 未成功：${run.errorMessage ?? run.status}`);
          }
          return { text: reviewRunText(run), usage: run.tokenUsage };
        },
        onStep: async (step) => {
          await appendAgentStep(deps.stateStore, pr.localId, step, now);
          deps.onStep?.(session.id, step);
        },
        signal: deps.signal,
      },
      {
        context: deps.agentContext,
        pr: { title: pr.title, description: pr.description, targetBranch: pr.targetRef.displayId },
        toolCatalog: deps.toolCatalog,
        matchedRule: deps.matchedRule,
        language: deps.language,
        userRequest,
        maxSteps: deps.maxSteps,
      },
    );

    return (
      (await updateAgentSession(deps.stateStore, pr.localId, {
        status: result.terminationReason === '用户暂停' ? 'paused' : 'done',
        summary: result.finalText,
        finishedAt: now().toISOString(),
        terminationReason: result.terminationReason,
      })) ?? session
    );
  } catch (err) {
    return (
      (await updateAgentSession(deps.stateStore, pr.localId, {
        status: 'failed',
        finishedAt: now().toISOString(),
        terminationReason: err instanceof Error ? err.message : String(err),
      })) ?? session
    );
  }
}
