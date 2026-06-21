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
  writeAgentConversation,
} from '@meebox/poller';
import type { AgentMessage } from '@meebox/shared';
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

// 会话压缩：存储超阈值时把较早消息摘要成一条 digest、仅留最近若干条原文，控制存储与后续注入规模
// （约定会话上下文不超 LLM 半窗：先压缩/裁剪再注入）。阈值高于注入预算，超出才触发、不频繁。
const CONVO_COMPACT_THRESHOLD_CHARS = 80000;
const CONVO_KEEP_RECENT = 6;
const COMPACT_SYSTEM =
  'You compress earlier turns of a conversation between a user and a code-review assistant into a ' +
  'concise digest. Preserve key facts, decisions, the user’s stated preferences / 称呼, and any open ' +
  'threads. Reply in the same language as the conversation. Output plain text only, no preamble.';

/** 存储超阈值时，把较早消息摘要为一条 digest 替换之；未超阈值 / 失败则原样保留。 */
async function maybeCompactConversation(
  stateStore: AgentPlanningDeps['stateStore'],
  chat: AgentPlanningDeps['chat'],
  prLocalId: string,
  now: () => Date,
): Promise<void> {
  const messages = await getAgentConversation(stateStore, prLocalId);
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total <= CONVO_COMPACT_THRESHOLD_CHARS || messages.length <= CONVO_KEEP_RECENT + 1) return;

  const older = messages.slice(0, -CONVO_KEEP_RECENT);
  const recent = messages.slice(-CONVO_KEEP_RECENT);
  const transcript = older
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
  try {
    const { text } = await chat({ system: COMPACT_SYSTEM, user: transcript });
    const digest: AgentMessage = {
      role: 'assistant',
      content: `（早期对话摘要）\n${text.trim()}`,
      // 用最早消息的时间戳，保证 digest 仍排在时间线最前。
      at: older[0]?.at ?? now().toISOString(),
    };
    await writeAgentConversation(stateStore, prLocalId, [digest, ...recent]);
  } catch {
    /* 压缩失败：保留原对话，下次再试（读时仍有预算裁剪兜底） */
  }
}

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
  /** 用户选中的代码引用（隐式上下文）：注入规划 LLM 当轮提示，不进持久化用户消息。 */
  referencedContext?: string;
  signal?: AbortSignal;
  onStep?: (sessionId: string, step: AgentStep) => void;
  /** 持久化 Agent 主动记下的非隐私条目到各可写上下文文件（USER/MEMORY/AGENTS）。 */
  recordMemory?: (notes: AgentMemoryNotes) => Promise<void>;
  /**
   * 取出运行期间排队的用户新消息（中途输入转向）：每轮顶部由 planner 调用。实现方（orchestrator）
   * 负责持久化进会话并广播刷新；此处直接透传给 planner，由其并入当轮 progress。
   */
  drainPendingInput?: () => Promise<string[]> | string[];
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
        drainPendingInput: deps.drainPendingInput,
      },
      {
        context: deps.agentContext,
        pr: { title: pr.title, description: pr.description, targetBranch: pr.targetRef.displayId },
        toolCatalog: deps.toolCatalog,
        matchedRule: deps.matchedRule,
        language: deps.language,
        userRequest,
        history,
        referencedContext: deps.referencedContext,
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

    // 会话超阈值时压缩较早消息（best-effort，不阻断收尾）。
    await maybeCompactConversation(deps.stateStore, deps.chat, pr.localId, now);

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
    // 用户停止（abort 杀掉在跑的 chat / 工具子进程 → 抛错）→ 干净的 paused 收尾，不当失败报错。
    const aborted = deps.signal?.aborted || (err instanceof Error && err.message === '用户暂停');
    return (
      (await updateAgentSession(deps.stateStore, pr.localId, {
        status: aborted ? 'paused' : 'failed',
        finishedAt: now().toISOString(),
        terminationReason: aborted ? '用户暂停' : err instanceof Error ? err.message : String(err),
      })) ?? session
    );
  }
}
