import type {
  AgentMessage,
  AgentRecommendation,
  AgentStep,
  AgentTodoItem,
  TokenUsage,
  ToolCatalogEntry,
} from '@meebox/shared';
import { assembleSystemContext, type AssemblePrMeta } from './prompts.js';
import type { MemoryNote } from './memory.js';
import { DEFAULT_STEP_LABELS, DEFAULT_SUMMARY_SECTIONS, type AgentStepLabels } from './orchestrator.js';
import { createStepRecorder } from './steps/context.js';
import {
  buildConversationContext,
  buildProtocol,
  planCycleStep,
  type PlanStepCtx,
} from './steps/planning/index.js';
import type { AgentContext } from './types.js';

/**
 * Free-planning (ReAct) orchestrator (see docs/arch/02-agent/02-session.md "session as agent"): handles natural-language requests from
 * the interactive entry point — driving the plan-cycle step repeatedly (each round chat plans the next action, calls a tool / finalizes), until final or the step cap. Complements the fixed
 * microflow (runReviewMicroflow). This file keeps only the **public types + driver**; single-step logic is in steps/planning.
 *
 * Pure logic: chat / runTool injected; the red line is enforced via assertToolAllowed (inside the plan-cycle step).
 */

export interface PlanningToolResult {
  text: string;
  usage?: TokenUsage;
}

export interface PlanningDeps {
  /** Planning LLM call (single system + user). */
  chat: (input: { system: string; user: string }) => Promise<PlanningToolResult>;
  /** Dispatch a tool, returning a text result (the red line has already been validated by the orchestrator). */
  runTool: (call: { tool: string; question?: string }) => Promise<PlanningToolResult>;
  onStep?: (step: AgentStep) => void | Promise<void>;
  /** User pause signal; after abort the loop stops before the next step and returns terminationReason='aborted' (stable code, mapped to localized text by the main process). */
  signal?: AbortSignal;
  /**
   * Drain new user messages queued during the run (mid-run input redirection): called at the top of each round; if non-empty, merge into this round's progress so ReAct can
   * reorder the next step per the latest instruction and current progress. Returned messages are persisted to the session by the implementer (main process) (here we only inject, not persist).
   */
  drainPendingInput?: () => Promise<string[]> | string[];
  /**
   * Plan (todo) update callback: called when the model gives / updates the plan each round, persisted (session.todo) + broadcast refresh by the implementer.
   * The plan is fed back into the prompt each round and reordered when new input arrives — see the plan convention in buildProtocol.
   */
  recordPlan?: (todo: AgentTodoItem[]) => void | Promise<void>;
}

export interface PlanningInput {
  context: AgentContext;
  pr: AssemblePrMeta;
  toolCatalog: ToolCatalogEntry[];
  /** Concatenated body of matched rules (multiple joined via combineRuleInstructions); pass empty / null when nothing matched. */
  matchedRuleInstructions?: string | null;
  language?: string;
  /** Step display text (injected by the main process after i18n resolution); omitted falls back to DEFAULT_STEP_LABELS (en-US). */
  labels?: AgentStepLabels;
  /** Review summary skeleton three-section headings (injected by the main process i18n into buildProtocol); omitted falls back to DEFAULT_SUMMARY_SECTIONS (en-US). */
  summarySections?: readonly [string, string, string];
  /** The user's natural-language request. */
  userRequest: string;
  /**
   * Prior multi-turn conversation (user / assistant messages, in ascending time order, excluding this round's request). Injected into the planning LLM's context so the
   * agent remembers earlier exchanges across rounds; **never** passed through to pr-agent tools (tools only see PR + this round's question).
   */
  history?: AgentMessage[];
  /**
   * Code reference selected by the user in the diff (self-describing block). Injected into this round's planning context so the agent knows which code the user is looking at;
   * **never** passed through to pr-agent tools (same constraint as history). Omitted = no selection reference this round.
   */
  referencedContext?: string;
  /** Step cap (default 8). */
  maxSteps?: number;
  /**
   * Per-session /ask count cap (follows the configured "follow-up count" max_followup_asks, default 2): each consecutive /ask is an agentic
   * exploration and costly, so cap it accordingly; unrelated to the "auto follow-up" toggle (the toggle only constrains the review microflow).
   */
  maxFollowupAsks?: number;
}

export interface PlanningResult {
  steps: AgentStep[];
  finalText: string;
  tokenUsage: TokenUsage;
  /** Summary recommendation (only for review-type requests; non-binding). For the UI to show the judge badge, consistent with AutoPilot / the microflow. */
  recommendation?: AgentRecommendation;
  /** Non-private entries actively noted this round, pending persistence to each writable file (dedup and disk write handled by the upper layer). */
  memories: AgentMemoryNotes;
  /** Stable code for the termination reason: 'aborted' (user pause) / 'max_steps' (step cap); localized text mapped by the main process. */
  terminationReason?: string;
}

/** Agent-authored memory, grouped by target writable file (keys aligned with WritableAgentFile), each entry with a target topic section. */
export interface AgentMemoryNotes {
  user: MemoryNote[];
  memory: MemoryNote[];
  agents: MemoryNote[];
}

function emptyMemoryNotes(): AgentMemoryNotes {
  return { user: [], memory: [], agents: [] };
}

/**
 * Driver: assemble system (incl. Protocol) + session context on the fly, running the plan-cycle step repeatedly until finalization / pause / step cap.
 * Single-step logic (build prompt / parse action / red line / dispatch tools / mid-run input / plan maintenance) is in planCycleStep under steps/planning.
 */
export async function runPlanningAgent(
  deps: PlanningDeps,
  input: PlanningInput,
): Promise<PlanningResult> {
  const maxSteps = input.maxSteps ?? 8;
  const rec = createStepRecorder(deps.onStep);
  const history: string[] = [];
  const memories = emptyMemoryNotes();
  const labels = input.labels ?? DEFAULT_STEP_LABELS;

  const system = `${assembleSystemContext({
    context: input.context,
    pr: input.pr,
    toolCatalog: input.toolCatalog,
    matchedRuleInstructions: input.matchedRuleInstructions,
    language: input.language,
  })}\n\n---\n\n# Protocol\n\n${buildProtocol(input.summarySections ?? DEFAULT_SUMMARY_SECTIONS)}`;

  // Inject prior multi-turn conversation into the planning context (trimmed by budget) so the agent remembers exchanges across rounds; only for the planning LLM's reference,
  // never passed through to pr-agent tools.
  const convo = buildConversationContext(input.history ?? []);
  const ctx: PlanStepCtx = {
    deps,
    input,
    rec,
    system,
    convo,
    labels,
    history,
    memories,
    plan: [],
    maxAsks: input.maxFollowupAsks ?? 2,
    asksUsed: 0,
  };

  // Planning is a single-step loop: run plan-cycle repeatedly until finalization / pause / step cap.
  for (let i = 0; i < maxSteps; i++) {
    const outcome = await planCycleStep.run(ctx);
    if (outcome.kind === 'aborted') {
      return { steps: rec.steps, finalText: '', tokenUsage: rec.usage, memories, terminationReason: 'aborted' };
    }
    if (outcome.kind === 'final') {
      return {
        steps: rec.steps,
        finalText: outcome.finalText,
        tokenUsage: rec.usage,
        recommendation: outcome.recommendation,
        memories,
      };
    }
  }

  return { steps: rec.steps, finalText: '', tokenUsage: rec.usage, memories, terminationReason: 'max_steps' };
}
