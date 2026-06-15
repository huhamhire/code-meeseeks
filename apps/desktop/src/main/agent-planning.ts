import {
  runPlanningAgent,
  type AgentContext,
  type AgentMemoryNotes,
  type PlanningToolResult,
} from '@meebox/agent';
import {
  appendAgentMessage,
  appendAgentStep,
  getAgentConversation,
  startAgentSession,
  updateAgentSession,
} from '@meebox/poller';
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
  /** 持久化 Agent 主动记下的非隐私条目到各可写上下文文件（USER/MEMORY/AGENTS）。 */
  recordMemory?: (notes: AgentMemoryNotes) => Promise<void>;
}

export async function runAgentPlanning(
  pr: StoredPullRequest,
  userRequest: string,
  deps: AgentPlanningDeps,
  now: () => Date = () => new Date(),
): Promise<AgentSession> {
  // 多轮对话：先读既往消息（注入规划上下文），再把本轮用户输入追加为一条消息（持久化）。
  const history = await getAgentConversation(deps.stateStore, pr.localId);
  await appendAgentMessage(deps.stateStore, pr.localId, { role: 'user', content: userRequest }, now);

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
        history,
        maxSteps: deps.maxSteps,
      },
    );

    // 把 Agent 收尾回答追加为一条助手消息（评审类带 recommendation）；暂停 / 空回答不记。
    if (result.finalText && result.terminationReason !== '用户暂停') {
      await appendAgentMessage(
        deps.stateStore,
        pr.localId,
        { role: 'assistant', content: result.finalText, recommendation: result.recommendation },
        now,
      );
    }

    // 持久化本轮主动记忆（非隐私）到各可写文件；失败不阻断会话收尾。
    const mem = result.memories;
    if (deps.recordMemory && (mem.user.length || mem.memory.length || mem.agents.length)) {
      await deps.recordMemory(mem);
    }

    return (
      (await updateAgentSession(deps.stateStore, pr.localId, {
        status: result.terminationReason === '用户暂停' ? 'paused' : 'done',
        summary: result.finalText,
        recommendation: result.recommendation,
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
