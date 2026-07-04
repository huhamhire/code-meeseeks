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
import { READ_RUN_TOOL_IDS, type AgentMessage } from '@meebox/shared';
import type {
  AgentSession,
  AgentStep,
  AgentTodoItem,
  ReviewRun,
  ReviewRunTool,
  StoredPullRequest,
  ToolCatalogEntry,
} from '@meebox/shared';
import type { StateStore } from '@meebox/state-store';
import { buildStepLabels, buildSummarySections, mapTerminationReason } from './labels.js';

/**
 * Wires the free-form planning orchestrator (runPlanningAgent) to the main process: "conversation as
 * delegation" from a natural-language entry point.
 * runTool maps read tools onto the existing pr-agent run queue; red lines are gated by the orchestrator
 * via assertToolAllowed. signal supports user pause (Stop); on pause → the session is set to paused to
 * preserve state.
 */

const STDOUT_LOG_SEP = '\n\n---\n[pr-agent stdout log]\n';
function reviewRunText(run: ReviewRun): string {
  return (run.stdout ?? '').split(STDOUT_LOG_SEP)[0]?.trim() ?? '';
}

// Conversation compaction: when storage exceeds the threshold, summarize earlier messages into a single
// digest and keep only the most recent few verbatim, controlling storage and later injection size (the
// convention is conversation context stays under half the LLM window: compact/trim before injecting). The
// threshold is above the injection budget, so it triggers only when exceeded, not frequently.
const CONVO_COMPACT_THRESHOLD_CHARS = 80000;
const CONVO_KEEP_RECENT = 6;
const COMPACT_SYSTEM =
  'You compress earlier turns of a conversation between a user and a code-review assistant into a ' +
  'concise digest. Preserve key facts, decisions, the user’s stated preferences / 称呼, and any open ' +
  'threads. Reply in the same language as the conversation. Output plain text only, no preamble.';

/** When storage exceeds the threshold, summarize earlier messages into a single digest and replace them; below the threshold / on failure, keep them as-is. */
async function maybeCompactConversation(
  stateStore: PlanningDeps['stateStore'],
  chat: PlanningDeps['chat'],
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
      // Use the earliest message's timestamp so the digest still sorts first on the timeline.
      at: older[0]?.at ?? now().toISOString(),
    };
    await writeAgentConversation(stateStore, prLocalId, [digest, ...recent]);
  } catch {
    /* Compaction failed: keep the original conversation, retry next time (read-time budget trimming still provides a fallback) */
  }
}

export interface PlanningDeps {
  stateStore: StateStore;
  enqueueRun: (pr: StoredPullRequest, tool: ReviewRunTool, question?: string) => Promise<ReviewRun>;
  chat: (input: { system: string; user: string }) => Promise<PlanningToolResult>;
  agentContext: AgentContext;
  toolCatalog: ToolCatalogEntry[];
  /** Concatenated body of matched rules (multiple joined via combineRuleInstructions); pass empty / null when no match. */
  matchedRuleInstructions?: string | null;
  language: string;
  maxSteps: number;
  /** /ask count cap for this session (config "follow-up count" max_followup_asks): continuous agentic exploration is costly, so cap it here. */
  maxFollowupAsks: number;
  /** User-selected code reference (implicit context): injected into the planning LLM's current-round prompt, not stored as a user message. */
  referencedContext?: string;
  signal?: AbortSignal;
  onStep?: (sessionId: string, step: AgentStep) => void;
  /** Persist non-private items the agent proactively noted into the writable context files (USER/MEMORY/AGENTS). */
  recordMemory?: (notes: AgentMemoryNotes) => Promise<void>;
  /**
   * Take the new user messages queued during the run (mid-run input redirect): called by the planner at the
   * top of each round. The implementer (orchestrator) is responsible for persisting them into the
   * conversation and broadcasting a refresh; here they are passed straight through to the planner, which
   * merges them into the current round's progress.
   */
  drainPendingInput?: () => Promise<string[]> | string[];
  /** Plan (todo) update callback: called when the planner produces / updates a plan, persisted + broadcast by the orchestrator. */
  recordPlan?: (todo: AgentTodoItem[]) => void | Promise<void>;
}

export async function runPlanning(
  pr: StoredPullRequest,
  userRequest: string,
  deps: PlanningDeps,
  now: () => Date = () => new Date(),
): Promise<AgentSession> {
  // Multi-turn conversation: first read prior messages (inject planning context), then append this round's user input as a message (persisted).
  const history = await getAgentConversation(deps.stateStore, pr.localId);
  await appendAgentMessage(
    deps.stateStore,
    pr.localId,
    // When a Diff selection reference is present, persist it alongside, for the UI to show the "referenced code" collapsed below the bubble.
    { role: 'user', content: userRequest, referencedContext: deps.referencedContext },
    now,
  );

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
          if (!READ_RUN_TOOL_IDS.has(bare)) throw new Error(`不支持的工具：${tool}`);
          const run = await deps.enqueueRun(pr, bare as ReviewRunTool, question);
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
        recordPlan: deps.recordPlan,
      },
      {
        context: deps.agentContext,
        pr: { title: pr.title, description: pr.description, targetBranch: pr.targetRef.displayId },
        toolCatalog: deps.toolCatalog,
        matchedRuleInstructions: deps.matchedRuleInstructions,
        language: deps.language,
        labels: buildStepLabels(),
        summarySections: buildSummarySections(),
        userRequest,
        history,
        referencedContext: deps.referencedContext,
        maxSteps: deps.maxSteps,
        maxFollowupAsks: deps.maxFollowupAsks,
      },
    );

    // Append the agent's closing answer as an assistant message (review-type carries recommendation); paused / empty answers are not recorded.
    if (result.finalText && result.terminationReason !== 'aborted') {
      await appendAgentMessage(
        deps.stateStore,
        pr.localId,
        { role: 'assistant', content: result.finalText, recommendation: result.recommendation },
        now,
      );
    }

    // Persist this round's proactive memories (non-private) to the writable files; failure does not block session finish.
    const mem = result.memories;
    if (deps.recordMemory && (mem.user.length || mem.memory.length || mem.agents.length)) {
      await deps.recordMemory(mem);
    }

    // When the conversation exceeds the threshold, compact earlier messages (best-effort, does not block finish).
    await maybeCompactConversation(deps.stateStore, deps.chat, pr.localId, now);

    return (
      (await updateAgentSession(deps.stateStore, pr.localId, {
        status: result.terminationReason === 'aborted' ? 'paused' : 'done',
        summary: result.finalText,
        recommendation: result.recommendation,
        finishedAt: now().toISOString(),
        terminationReason: mapTerminationReason(result.terminationReason),
      })) ?? session
    );
  } catch (err) {
    // User stop (abort kills the running chat / tool subprocess → throws) → clean paused finish, not reported as a failure.
    const aborted = deps.signal?.aborted || (err instanceof Error && err.message === 'aborted');
    return (
      (await updateAgentSession(deps.stateStore, pr.localId, {
        status: aborted ? 'paused' : 'failed',
        finishedAt: now().toISOString(),
        terminationReason: aborted
          ? mapTerminationReason('aborted')
          : err instanceof Error
            ? err.message
            : String(err),
      })) ?? session
    );
  }
}
