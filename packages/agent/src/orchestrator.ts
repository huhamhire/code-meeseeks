import type {
  AgentRecommendation,
  AgentStep,
  AskVerdict,
  Finding,
  ReviewRun,
  ReviewRunTool,
  TokenUsage,
  ToolCatalogEntry,
} from '@meebox/shared';
import { assembleSystemContext, type AssemblePrMeta } from './prompts.js';
import { createStepRecorder } from './steps/context.js';
import {
  DEFAULT_REVIEW_PLAN,
  assembleReviewSteps,
  isValidReviewPlan,
  type ReviewPlan,
  type ReviewStepCtx,
} from './steps/review/index.js';
import type { AgentContext } from './types.js';

/**
 * Structured "review microflow" orchestrator (see docs/arch/02-agent/03-autopilot.md "AutoPilot" bounded microflow):
 * describe → review → (only for severe issues) conditional follow-up asks ≤N → summary + recommendation.
 *
 * This is a **fixed template**, not free ReAct: the flow is determined by code, the LLM only makes limited judgments
 * in two places (judge severity / produce summary), so it is robust, predictable, and step-bounded — fitting the per-PR sub-agent design.
 * Pure logic: tool dispatch (runTool) and the LLM channel (chat) are injected by the caller, easing unit testing and reuse.
 */

export interface ToolText {
  text: string;
  usage?: TokenUsage;
  /** id of this tool run (PR3: needed to reference judge callouts / asks re-review association, backfilled by review / ask). */
  runId?: string;
  /** parsed structured findings (backfilled by review, for judge to call out for re-review by id). */
  findings?: Finding[];
  /** re-review /ask verdict (backfilled by ask in re-review mode; the asks step auto-closes the original finding accordingly). */
  askVerdict?: AskVerdict;
}

export interface ReviewOrchestratorDeps {
  /**
   * Dispatch a read-only pr-agent tool, returning the result (description / findings / answer + runId / findings / askVerdict).
   * referencedContext / referencedFinding are only for re-review mode /ask: inject the re-reviewed comment context + structured reference forward chain.
   */
  runTool(call: {
    tool: ReviewRunTool;
    question?: string;
    referencedContext?: string;
    referencedFinding?: ReviewRun['referencedFinding'];
  }): Promise<ToolText>;
  /** Run one limited conversation over an independent LLM channel (judge severity / produce summary). maxOutputTokens can cap output for lightweight routing judgments. */
  chat(input: { system: string; user: string; maxOutputTokens?: number }): Promise<ToolText>;
  /** Callback on each orchestration step produced (persistence / streaming push). */
  onStep?(step: AgentStep): void | Promise<void>;
  /**
   * PR3: when a re-review ask verdict is replace/drop, auto-close the superseded original review finding (establish a FindingClosure).
   * Omitted = do not close (in unit tests / when not wired to the main process).
   */
  closeFinding?(call: {
    runId: string;
    findingId: string;
    byAskRunId: string;
    verdict: AskVerdict;
  }): Promise<void>;
  /** User stop: boundary check at each step; if already aborted, throw `aborted` to halt the microflow (can terminate immediately even during the thinking phase). */
  signal?: AbortSignal;
}

export interface ReviewOrchestratorInput {
  context: AgentContext;
  pr: AssemblePrMeta;
  /** Concatenated body of matched rules (multiple joined via combineRuleInstructions); pass empty / null when nothing matched. */
  matchedRuleInstructions?: string | null;
  language?: string;
  /** Step display text (injected by the main process after i18n resolution); omitted falls back to DEFAULT_STEP_LABELS (en-US). */
  labels?: AgentStepLabels;
  /** Summary three-section skeleton headings (injected by the main process i18n); omitted falls back to DEFAULT_SUMMARY_SECTIONS (en-US). */
  summarySections?: readonly [string, string, string];
  /** Tool catalog injected into the prompt (with modification red-line annotations, see buildToolCatalog). */
  toolCatalog?: ToolCatalogEntry[];
  /** Hard cap on conditional follow-up asks (default 2). */
  maxFollowupAsks?: number;
  /** **Reference** cap on summary length (default 800 chars): only a soft constraint in the prompt to guide the LLM to converge, **not** a hard truncation on the output. */
  summaryMaxChars?: number;
  /**
   * Execution plan (step sequence). When omitted / invalid, use DEFAULT_REVIEW_PLAN (i.e. describe-review → judge → asks →
   * summary, same as before splitting the plan out). Only the AutoPilot path injects a custom plan per rules; manual review always omits it and takes the default.
   */
  plan?: ReviewPlan;
}

export interface ReviewOrchestratorResult {
  steps: AgentStep[];
  summary: string;
  recommendation: AgentRecommendation;
  tokenUsage: TokenUsage;
  terminationReason?: string;
}

/** **Default value (en-US fallback)** for the review summary's three-section skeleton headings: order is fixed as Summary / Key findings / Suggestions. Localized translations are
 *  resolved by the caller (main process i18n resources) and injected via input.summarySections; when not injected, falls back to this default. */
export const DEFAULT_SUMMARY_SECTIONS: readonly [string, string, string] = [
  'Summary',
  'Key findings',
  'Suggestions',
];

/**
 * Fixed text **directly displayed** to the user in orchestration / planning step rows (thought / judge result / fallback recommendation reason / rejection prefix).
 * These strings are persisted in the transcript and shown verbatim by the render layer (not via i18next key mapping), so they must already be target-language text **at generation time**:
 * resolved by the caller (main process i18n resources) and injected via input.labels, with the agent keeping only an en-US fallback (DEFAULT_STEP_LABELS).
 * Free-form thought generated by the LLM already follows the answer language and is not covered here; switching UI language afterward does not rewrite historical steps (same as the summary body).
 */
export interface AgentStepLabels {
  /** Microflow "generate PR description and review findings" step thought (describe + review merged into one row; the two run in parallel). */
  describeReview: string;
  /** Microflow "generate code improvement suggestions" step thought (/improve; only appears when included by the rule plan). */
  improve: string;
  /** Microflow judge step thought. */
  judge: string;
  /** Judge result: severe issues exist, will follow up with n asks. */
  judgeSevere: (n: number) => string;
  /** Judge result: no severe issues, no follow-up. */
  judgeNone: string;
  /** Summary step thought. */
  summary: string;
  /** Planning step: result prefix when a tool call is rejected by the red line (followed by the specific reason). */
  rejectedPrefix: string;
}
/** Default value for step text (en-US fallback); localized versions are resolved by the main process i18n and injected via input.labels, falling back to this default when not injected. */
export const DEFAULT_STEP_LABELS: AgentStepLabels = {
  describeReview: 'Generate the PR description and review findings',
  improve: 'Generate code improvement suggestions',
  judge: 'Decide whether there are important issues needing follow-up',
  judgeSevere: (n) => `Important — ${String(n)} follow-up question${n === 1 ? '' : 's'}`,
  judgeNone: 'No important issues — no follow-up',
  summary: 'Synthesize the description and findings into a review summary',
  rejectedPrefix: 'Rejected: ',
};

/**
 * Run one review microflow: by default describe → review → (only for severe issues) conditional follow-up asks ≤N → summary + recommendation. Uses only read-only tools
 * (describe/review/ask), never touching modification operations. The driver runs each step in order via assembleReviewSteps per input.plan (omitted / invalid falls back to DEFAULT_REVIEW_PLAN),
 * sharing a StepRecorder with each step.
 */
export async function runReviewMicroflow(
  deps: ReviewOrchestratorDeps,
  input: ReviewOrchestratorInput,
): Promise<ReviewOrchestratorResult> {
  const labels = input.labels ?? DEFAULT_STEP_LABELS;
  const rec = createStepRecorder(deps.onStep);
  const checkAbort = (): void => {
    // Throw the stable code 'aborted' (not localized text): the main process finalizes as paused per signal.aborted / this code and lands localized text.
    if (deps.signal?.aborted) throw new Error('aborted');
  };
  // base system context (tool catalog left empty: the microflow does not expose free tool selection).
  const system = assembleSystemContext({
    context: input.context,
    pr: input.pr,
    toolCatalog: input.toolCatalog ?? [],
    matchedRuleInstructions: input.matchedRuleInstructions,
    language: input.language,
  });
  const ctx: ReviewStepCtx = {
    deps,
    input,
    rec,
    checkAbort,
    maxAsks: input.maxFollowupAsks ?? 2,
    summaryMax: input.summaryMaxChars ?? 800,
    labels,
    system,
    bag: { asks: [], askResults: [] },
  };

  // Plan: omitted / invalid (e.g. judge/summary missing the prerequisite describe-review) always falls back to the full default set, avoiding a bad plan crashing inside a step.
  const plan = input.plan && isValidReviewPlan(input.plan) ? input.plan : DEFAULT_REVIEW_PLAN;
  for (const step of assembleReviewSteps(plan)) await step.run(ctx);

  return {
    steps: rec.steps,
    summary: ctx.bag.summary ?? '',
    // Fallback (summary step produced no recommendation): switch to manual review, without a reason — a parse-failure fallback has no user value, and the frontend hides the
    // gray text on an empty reason (same convention as summary-step).
    recommendation: ctx.bag.recommendation ?? { verdict: 'manual_review', reason: '' },
    tokenUsage: rec.usage,
  };
}
