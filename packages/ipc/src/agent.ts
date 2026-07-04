import type {
  AgentMessage,
  AgentRecommendationVerdict,
  AgentSession,
  AgentStep,
  ReviewRun,
  ReviewRunCommitScope,
  ReviewRunTool,
} from '@meebox/shared';
import type { PragentRunInfo } from './common.js';

/** Agent interaction domain: rule matching / review orchestration / free planning / session and ledger / pr-agent run queue. */
export interface AgentChannels {
  /**
   * For a given PR, query the **all rules** currently matched in `<agent.dir>/rules` (by priority desc + path asc, capped at the first several,
   * same standard as review injection). Caller passes tool to distinguish /describe / /review (a rule may apply to only one of the tools).
   * agent.dir unconfigured / globally disabled / no match → returns empty array.
   */
  'rules:matchForPr': {
    request: { localId: string; tool: ReviewRunTool };
    response: Array<{
      id: string;
      filePath: string;
      priority: number;
      tools: ReviewRunTool[];
      instructions: string;
    }>;
  };
  /**
   * Run one Agent review micro-flow for a given PR (describe→review→conditional follow-up→summary). Waits synchronously,
   * pushing steps via agent:stepProgress meanwhile; returns the finalized AgentSession (with summary /
   * recommendation). Rejects when pr-agent is unavailable.
   */
  'agent:run': {
    request: { localId: string };
    response: AgentSession;
  };
  /**
   * Run the free-planning Agent for a given PR (natural-language entry "conversation as delegation"). Waits synchronously, steps pushed via
   * agent:stepProgress; returns the finalized session (summary = Agent's final answer).
   */
  'agent:ask': {
    /**
     * referencedContext: the code snippet the user selected in the Diff (with path + line range + code), injected as **implicit context**
     * into this turn's prompt for the planning LLM, not entering the persisted user message body. Omitted = no selection reference this turn.
     */
    request: { localId: string; question: string; referencedContext?: string };
    response: AgentSession;
  };
  /** Pause the current PR's Agent run (abort); session set to paused, state preserved. */
  'agent:stop': { request: { localId: string }; response: { ok: boolean } };
  /**
   * Append a user message during a run: if an Agent is running for this PR → enqueue, merged into the next main Agent cycle and re-ordered per the latest instruction
   * (queued=true); if none is running → directly start one free-planning round (queued=false, race fallback, no message lost).
   */
  'agent:enqueueMessage': {
    request: { localId: string; message: string };
    response: { queued: boolean };
  };
  /**
   * Read a given PR's persisted Agent session (with final summary / recommendation); returns null if none.
   * Used by the UI to restore the "review summary" card when opening a PR—the summary belongs to its originating PR, not lost across PR switches, no cross-talk.
   */
  'agent:getSession': { request: { localId: string }; response: AgentSession | null };
  /**
   * Read a given PR's multi-turn conversation messages (user input + Agent answers, ascending by time); empty array if none.
   * The UI renders the multi-turn conversation from this; restored across PR switches / restart.
   */
  'agent:getConversation': { request: { localId: string }; response: AgentMessage[] };
  /**
   * Read a given PR's persisted Agent process steps (transcript, ascending by time); empty array if none.
   * The UI restores the "process tracking" thinking steps from this—not lost across PR switches / restart (steps are persisted incrementally as produced).
   */
  'agent:getTranscript': { request: { localId: string }; response: AgentStep[] };
  /**
   * Batch-read AutoPilot ledgers: returns each PR's auto-reviewed recommendation (only decision=review with a
   * suggester). The PR list shows badges from this, without loading sessions one by one.
   */
  'agent:autopilotLedgers': {
    request: { localIds: string[] };
    response: Record<string, AgentRecommendationVerdict>;
  };
  // ── pr-agent run queue (review tool execution layer; agent:run / AutoPilot and user manual runs share the same queue) ──
  /**
   * Trigger one pr-agent /describe or /review. Waits synchronously for execution to finish (may take tens of seconds to minutes),
   * pushing stdout / stderr lines via pragent:runProgress events meanwhile. Returns the final ReviewRun
   * status (succeeded / failed). Rejects when pr-agent is unavailable.
   */
  'pragent:run': {
    /**
     * When tool='ask', question is required, passed as the positional argument to the pr-agent CLI's ask subcommand.
     * When tool='describe'/'review', the question field is ignored.
     * referencedContext: the code snippet the user selected in the Diff (implicit context), effective only when tool='ask'—injected via
     * EXTRA_INSTRUCTIONS, not entering the question positional argument (so it doesn't pollute the answer echo / conversation bubble).
     * referencedFinding: re-review reference—this /ask is a re-review of some prior review/improve finding (forward chain,
     * lands on ReviewRun.referencedFinding), driving the re-review-mode prompt + the result card's verdict actions. Effective only when tool='ask'.
     * scope: single-commit review range (parent..sha)—initiated by the Diff view's commit selector, limiting this run's diff to
     * that commit's own changes rather than the whole PR. Effective for describe/review/ask/improve; default = whole-PR range.
     */
    request: {
      localId: string;
      tool: ReviewRunTool;
      question?: string;
      referencedContext?: string;
      referencedFinding?: ReviewRun['referencedFinding'];
      scope?: ReviewRunCommitScope;
    };
    response: ReviewRun;
  };
  /**
   * List a PR's historical runs, newest first. Supports timestamp-cursor pagination:
   * - limit: cap at N entries; omitted = unlimited (use with care on the renderer, may be slow at scale)
   * - beforeId: cursor, returns entries with runId **strictly less than** this value; omitted = no upper bound
   *
   * runId is time-ordered lexicographically (`yyyymmdd-HHmmss-mmm`), so "take N entries after the cursor" is "take the N entries before this moment"
   */
  'pragent:listRuns': {
    request: { localId: string; limit?: number; beforeId?: string };
    response: ReviewRun[];
  };
  /** Single-run query (for the renderer to fall back and refresh after an event stream drops) */
  'pragent:getRun': {
    request: { localId: string; runId: string };
    response: ReviewRun | null;
  };
  /** Clear all run history for a given PR (effective only for that PR). Returns the number deleted. */
  'pragent:clearRuns': {
    request: { localId: string };
    response: { cleared: number };
  };
  /** Delete a single run record of a given PR (only that run, leaving the Agent session / ledger untouched). Returns whether something was actually deleted. */
  'pragent:deleteRun': {
    request: { localId: string; runId: string };
    response: { ok: boolean };
  };
  /**
   * Cancel a run. Semantics depend on the run's current state:
   * - matches active → SIGKILL the child process, persist status='cancelled'
   * - in the waiting queue → remove from the queue, do **not** write to disk (never actually ran); trigger the pragent:run
   *   original caller's Promise reject so ChatPane handleRun takes the error branch
   * - matches neither (already finished / nonexistent) → silent no-op (returns ok:false)
   */
  'pragent:cancel': {
    request: { runId: string };
    response: { ok: boolean };
  };
  /**
   * Query the current queue snapshot (active + waiting); the renderer pulls it on startup / reconnect,
   * as a fallback paired with the queueChanged event.
   */
  'pragent:queue': {
    request: void;
    response: { active: PragentRunInfo[]; waiting: PragentRunInfo[] };
  };
}
