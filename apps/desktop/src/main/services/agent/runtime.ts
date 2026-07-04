import type { AgentSession, AgentStep, StoredPullRequest, TokenUsage } from '@meebox/shared';
import type { ServiceContext } from '../context.js';
import type { RunQueue } from '../pr-agent/index.js';

/** Shared chat channel: system + user → text + usage. Used by both agent:run review and AutoPilot. */
export type AgentChat = (input: {
  system: string;
  user: string;
  /** Output token cap (for capping lightweight routing reads, see ChatRunOptions.maxOutputTokens). */
  maxOutputTokens?: number;
}) => Promise<{ text: string; usage?: TokenUsage }>;

/**
 * Orchestration runtime: the state-access + shared-helper surface the stateful coordinator (Orchestrator)
 * exposes to the flows (review / planning / autopilot). Flows are split one-task-per-file as free
 * functions, reusing the coordinator's runtime state and common capabilities via this runtime rather than
 * each holding mutable state. Orchestrator implements this interface and passes `this` as the runtime into
 * each flow.
 */
export interface OrchestratorRuntime {
  readonly ctx: ServiceContext;
  readonly runQueue: RunQueue;
  /** Register a PR's AbortController (used by the stop button agent:stop). */
  registerController(localId: string, ac: AbortController): void;
  /** Clear a PR's AbortController (on finish). */
  clearController(localId: string): void;
  /** Mark a PR "running" and broadcast (shown even in the pure-thinking stage). */
  markRunning(localId: string): void;
  /** Clear a PR's "running" mark and broadcast. */
  unmarkRunning(localId: string): void;
  /** Unified step exit: background log + agent:stepProgress broadcast. */
  emitStep(pr: StoredPullRequest, sessionId: string, step: AgentStep): void;
  /** Take and clear a PR's pending user messages (mid-run input redirect). */
  takePending(localId: string): string[];
  /** Set up LLM env + temp chat cwd + chat function, run fn, then clean up the temp dir on finish. */
  withAgentChat<T>(fn: (chat: AgentChat) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Unified review summary landing: on success with a summary, append the assistant summary message + write the ledger + broadcast the conversation change. */
  recordReviewSummaryMessage(pr: StoredPullRequest, session: AgentSession): Promise<void>;
  /** Set / clear the AutoPilot single-concurrency busy lock. */
  setAutopilotBusy(busy: boolean): void;
}
