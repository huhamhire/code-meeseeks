/**
 * Session and tool contract types for the high-level Agent (see docs/arch/02-agent/02-session.md "Agentifying the session" and "Data contract").
 * These types are **persisted** (@meebox/poller), **transported over IPC** (ipc.ts), and rendered in the renderer,
 * so they live in shared (alongside ReviewRun / Finding). @meebox/agent's pure logic references them from here.
 */

import type { TokenUsage } from './poller-contract.js';

/** A tool's side-effect classification and availability (the basis for enforcing the red lines, see "Tool mutation red lines"). */
export interface ToolCatalogEntry {
  /** Tool command name, e.g. `/describe`. */
  name: string;
  /** Semantic description, injected into the prompt so the Agent understands when to call it. */
  summary: string;
  /** Whether it is mutating (has side effects on the remote). Read/analysis tools = false. */
  mutating: boolean;
  /** Whether the Agent may call it autonomously: mutating tools are false when unauthorized (injected in a disabled state). */
  enabled: boolean;
}

export type AgentSessionStatus = 'running' | 'paused' | 'done' | 'failed' | 'cancelled';

/** The kind of orchestration step: planning / tool dispatch / judging (see "Metering boundary between steps and sub-tasks"). */
export type AgentStepKind = 'plan' | 'tool' | 'judge';

export interface AgentTodoItem {
  id: string;
  text: string;
  done: boolean;
}

export interface AgentToolCall {
  /** The dispatched tool name (e.g. `/review`). */
  tool: string;
  args?: Record<string, unknown>;
}

/** An orchestration-level step (one decision round of the orchestration agent, excluding the internal cost of a pr-agent run). */
export interface AgentStep {
  kind: AgentStepKind;
  /** Thought summary (archived + streamed). */
  thought?: string;
  /** The tool call when kind='tool'. */
  toolCall?: AgentToolCall;
  /** Summary of the tool result / judging conclusion. */
  result?: string;
  /** This step's **own** LLM token usage (not cumulative, not including other steps): reasoning steps that go through a dedicated channel such as judge / summary / planning carry a value here;
   *  the tool cost of describe/review/ask is borne by their respective run cards and is not counted again on the step. The UI shows it on the step row so each step's cost is visible. */
  usage?: TokenUsage;
  /** Step creation time (ISO). */
  at?: string;
  /** This step's thinking (the single LLM inference that produced the decision) duration (ms); a per-step timing like Claude Code's "Thought for Ns".
   *  Only reasoning steps (plan/judge) have a value; fixed dispatch (such as the micro-flow's describe/review choice) has no LLM thinking and is left unset. */
  thinkMs?: number;
  /** Whether triggered by an AutoPilot background review: marked only on the first step of that review, so the UI shows a robot chip on the step row. */
  autopilot?: boolean;
}

export type AgentRecommendationVerdict = 'approve' | 'needs_work' | 'manual_review';

/** Summary recommendation (non-binding, triggers no write operations, see "AutoPilot"). */
export interface AgentRecommendation {
  verdict: AgentRecommendationVerdict;
  reason: string;
}

export type AgentMessageRole = 'user' | 'assistant';

/**
 * A single conversation message (turn-level, distinct from the AgentStep within a turn). The persistence unit for multi-turn conversations:
 * one each for the user input and the Agent's summary answer, appended by time. The Agent's own context (planning) reads historical messages,
 * but **never** injects them into pr-agent tool calls (tools only see the PR + the current turn's question).
 */
export interface AgentMessage {
  role: AgentMessageRole;
  content: string;
  /** Non-binding verdict for an assistant review-type turn; not set for conversation / user messages. */
  recommendation?: AgentRecommendation;
  /**
   * Referenced context carried by a user message (self-describing markdown: path + line range + code fence, see
   * renderer formatReferencedContext). Set when a question is asked with a Diff selection, and the UI shows it collapsed below the bubble;
   * not set when there is no selection / for assistant messages. (Finding references go through the /ask run card, not this field.)
   */
  referencedContext?: string;
  /** Creation time (ISO), used for timeline ordering. */
  at: string;
}

/** Persistence wrapper: `prs/<localId>/agent/conversation.json` (multi-turn messages appended streaming, retained across turns). */
export interface AgentConversationFile {
  schema_version: 1;
  messages: AgentMessage[];
}

/** One per PR, the session record owned by the sub-agent (see the data contract). */
export interface AgentSession {
  id: string;
  prLocalId: string;
  status: AgentSessionStatus;
  todo: AgentTodoItem[];
  stepCount: number;
  maxSteps: number;
  /**
   * The user's natural-language request that triggered this session ("conversation as delegation" entry agent:ask). An automatic review (agent:run)
   * has no text input → not set. The UI uses it to echo the user input as a right-aligned bubble, attribute it to its originating PR, and restore it on persistence.
   */
  userRequest?: string;
  /** This PR's summary body (summary_max_chars is only a soft prompt constraint to guide length, not a hard truncation of the body). */
  summary?: string;
  /** Summary recommendation (non-binding). */
  recommendation?: AgentRecommendation;
  startedAt: string;
  finishedAt?: string;
  /** Termination reason (e.g. "aborted at step limit", "user paused"). */
  terminationReason?: string;
}

/** Persistence wrapper: `prs/<localId>/agent/session.json`. */
export interface AgentSessionFile {
  schema_version: 1;
  session: AgentSession;
}

/** Persistence wrapper: `prs/<localId>/agent/transcript.json` (steps appended streaming). */
export interface AgentTranscriptFile {
  schema_version: 1;
  steps: AgentStep[];
}

export type AutopilotDecision = 'review' | 'skipped';

/**
 * One AutoPilot ledger entry per PR: dedup + audit (see docs/arch/02-agent/03-autopilot.md "AutoPilot").
 * Whether "the current version has not been auto-reviewed" is decided by whether `autoReviewedUpdatedAt` matches the current PR's `updatedAt`,
 * so a PR re-enters candidacy after pushing a new commit, and does not re-run when the content is unchanged.
 */
export interface AutopilotLedger {
  prLocalId: string;
  /** Snapshot of the PR's updatedAt at the time of the review / decision. */
  autoReviewedUpdatedAt: string;
  decision: AutopilotDecision;
  /** Decision reason (especially useful when skipped, for audit / UI display). */
  reason?: string;
  /** If reviewed, the recommendation leaning given by the sub-agent (read directly by the PR list badge, no need to load the session). */
  recommendation?: AgentRecommendationVerdict;
  /** Write time (ISO). */
  at: string;
}

/** Persistence wrapper: `prs/<localId>/agent/autopilot.json`. */
export interface AutopilotLedgerFile {
  schema_version: 1;
  ledger: AutopilotLedger;
}
