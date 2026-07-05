import { runReviewMicroflow, type AgentContext, type ReviewPlan } from '@meebox/agent';
import { appendAgentStep, startAgentSession, updateAgentSession } from '@meebox/poller';
import type {
  AgentSession,
  AgentStep,
  AskVerdict,
  ReviewRun,
  ReviewRunTool,
  StoredPullRequest,
  TokenUsage,
  ToolCatalogEntry,
} from '@meebox/shared';
import type { StateStore } from '@meebox/state-store';
import { buildStepLabels, buildSummarySections, mapTerminationReason } from './labels.js';

/**
 * Wires the pure-logic `runReviewMicroflow` onto main-process capabilities (see
 * docs/arch/02-agent/01-agent.md "AutoPilot" bounded micro-flow):
 * - runTool: run describe/review/ask via the existing pr-agent run queue, take the artifact text and feed it back;
 * - chat: make constrained judgments / summaries via the embedded runtime's independent LLM channel;
 * - persistence + step streaming: startAgentSession / appendAgentStep / updateAgentSession + onStep broadcast.
 */

const STDOUT_LOG_SEP = '\n\n---\n[pr-agent stdout log]\n';

/** Take a run's "real LLM output" (strip the pr-agent stdout log segment ipc appended at the end). */
function reviewRunText(run: ReviewRun): string {
  return (run.stdout ?? '').split(STDOUT_LOG_SEP)[0]?.trim() ?? '';
}

export interface ReviewDeps {
  stateStore: StateStore;
  /** Enqueue a pr-agent run, resolving the completed ReviewRun (shares the queue with user manual runs). Re-review /ask carries reference context + forward chain. */
  enqueueRun: (
    pr: StoredPullRequest,
    tool: ReviewRunTool,
    question?: string,
    referencedContext?: string,
    referencedFinding?: ReviewRun['referencedFinding'],
  ) => Promise<ReviewRun>;
  /** Re-review verdict replace/drop → close the superseded original review finding (write FindingClosure + broadcast). Default = don't close. */
  closeFinding?: (
    pr: StoredPullRequest,
    call: { runId: string; findingId: string; byAskRunId: string; verdict: AskVerdict },
  ) => Promise<void>;
  /** Run one constrained conversation via the independent LLM channel (judge severity / produce summary). */
  chat: (input: { system: string; user: string }) => Promise<{ text: string; usage?: TokenUsage }>;
  agentContext: AgentContext;
  /** Concatenated body of matched rules (multiple joined via combineRuleInstructions); pass empty / null when no match. */
  matchedRuleInstructions?: string | null;
  language: string;
  /** Tool catalog (with modification red-line annotations); injected into the orchestrator's system context. */
  toolCatalog?: ToolCatalogEntry[];
  maxFollowupAsks: number;
  summaryMaxChars: number;
  /** Review execution plan (step sequence); when omitted / invalid the micro-flow falls back to the default full set. Injected by rule only for AutoPilot, omitted for manual review. */
  plan?: ReviewPlan;
  /** Step streaming callback (broadcast to the renderer). */
  onStep?: (sessionId: string, step: AgentStep) => void;
  /** User stop: passed through to the micro-flow, can abort immediately at any stage of thinking / execution (stop button → agent:stop). */
  signal?: AbortSignal;
  /** Whether this is an AutoPilot background dispatch: tagged onto this review's **first step**, so the UI marks a robot chip on the step row. */
  autopilot?: boolean;
}

/**
 * Run the review micro-flow on a PR and persist the session. Returns the finished AgentSession (done on
 * success / failed on failure). Tool failures inside the micro-flow throw; here they are caught into a
 * failed session rather than re-thrown (background automation shouldn't crash the main flow).
 */
export async function runReview(
  pr: StoredPullRequest,
  deps: ReviewDeps,
  now: () => Date = () => new Date(),
): Promise<AgentSession> {
  // The step cap is derived from the micro-flow template: describe + review + ≤N follow-up asks + summary (+ judgment margin).
  const session = await startAgentSession(
    deps.stateStore,
    { prLocalId: pr.localId, maxSteps: 3 + deps.maxFollowupAsks + 1 },
    now,
  );

  // On AutoPilot trigger, the robot mark is placed only on this review's **first step** (the first step being "generate PR description and review findings").
  let firstStep = true;
  try {
    const result = await runReviewMicroflow(
      {
        runTool: async ({ tool, question, referencedContext, referencedFinding }) => {
          const run = await deps.enqueueRun(
            pr,
            tool,
            question,
            referencedContext,
            referencedFinding,
          );
          if (run.status !== 'succeeded') {
            throw new Error(`pr-agent ${tool} 未成功：${run.errorMessage ?? run.status}`);
          }
          // Carry back runId / findings / askVerdict: lets the judge name findings by id, and links asks re-review with auto-close.
          return {
            text: reviewRunText(run),
            usage: run.tokenUsage,
            runId: run.id,
            findings: run.findings,
            askVerdict: run.askVerdict,
          };
        },
        closeFinding: deps.closeFinding ? (call) => deps.closeFinding!(pr, call) : undefined,
        chat: deps.chat,
        onStep: async (step) => {
          const tagged = deps.autopilot && firstStep ? { ...step, autopilot: true } : step;
          firstStep = false;
          await appendAgentStep(deps.stateStore, pr.localId, tagged, now);
          deps.onStep?.(session.id, tagged);
        },
        signal: deps.signal,
      },
      {
        context: deps.agentContext,
        pr: { title: pr.title, description: pr.description, targetBranch: pr.targetRef.displayId },
        matchedRuleInstructions: deps.matchedRuleInstructions,
        language: deps.language,
        labels: buildStepLabels(),
        summarySections: buildSummarySections(),
        toolCatalog: deps.toolCatalog,
        plan: deps.plan,
        maxFollowupAsks: deps.maxFollowupAsks,
        summaryMaxChars: deps.summaryMaxChars,
      },
    );

    return (
      (await updateAgentSession(deps.stateStore, pr.localId, {
        status: 'done',
        summary: result.summary,
        recommendation: result.recommendation,
        finishedAt: now().toISOString(),
      })) ?? session
    );
  } catch (err) {
    // User stop (abort) → clean paused finish, not reported as a failure; other exceptions are still recorded as failed.
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
