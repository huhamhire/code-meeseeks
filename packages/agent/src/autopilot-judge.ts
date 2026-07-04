import type { TokenUsage } from '@meebox/shared';
import { DESC_CLAMP } from './constants.js';
import { PROMPT_TEMPLATES } from './prompts.js';
import { isValidReviewPlan, type ReviewPlan, type ReviewStepKind } from './steps/review/index.js';
import { extractJson, fillTemplate } from './utils/index.js';

/** Parse the step plan given by the judge: non-array / contains invalid kind / missing prerequisite describe-review → undefined (falls back to the default full set). */
function parseReviewPlan(raw: unknown): ReviewPlan | undefined {
  if (!Array.isArray(raw)) return undefined;
  const steps = raw.filter((s): s is ReviewStepKind => typeof s === 'string') as ReviewStepKind[];
  const plan: ReviewPlan = { steps };
  return isValidReviewPlan(plan) ? plan : undefined;
}

/**
 * AutoPilot batch judge (see the exception rules in docs/arch/02-agent/03-autopilot.md「AutoPilot」): feed a batch of candidate PRs'
 * titles + descriptions to the LLM, judge per PR "whether it is worth auto-reviewing" and attach a reason (e.g. branch merge / back-merge kind,
 * pure dependency bumps can be skipped). Pure logic: the LLM channel is injected, unit-testable.
 */

export interface JudgeCandidate {
  prLocalId: string;
  title: string;
  description?: string;
  /** Source / target branch names (background input, aids judging branch merge / back-merge). */
  sourceBranch?: string;
  targetBranch?: string;
  /** "Pure branch merge" determined from the **actual commit structure** (commits are all merge commits, see classifyBranchMerge). */
  branchMerge?: boolean;
  /** Source branch is a long-lived / integration branch (background signal; does not alone constitute a skip reason, left to the judge to weigh). */
  sourceMainline?: boolean;
}

export interface JudgeDecision {
  prLocalId: string;
  review: boolean;
  reason: string;
  /**
   * The PR's review execution plan (step sequence). This iteration's judge **does not produce it** (always omitted → uses DEFAULT_REVIEW_PLAN); reserved as
   * the injection point for later "rule-driven step selection": the judge prompt + AGENTS.md rules can give a per-PR plan (skip / reorder / add / remove steps).
   */
  plan?: ReviewPlan;
}

export interface AutopilotJudgeInput {
  candidates: JudgeCandidate[];
  /** AGENTS.md body: source of exception rules (skip conditions can be extended within it). */
  agentsRules?: string;
}

export interface AutopilotJudgeResult {
  decisions: JudgeDecision[];
  usage?: TokenUsage;
}

export async function judgeAutopilotBatch(
  chat: (input: { system: string; user: string }) => Promise<{ text: string; usage?: TokenUsage }>,
  input: AutopilotJudgeInput,
): Promise<AutopilotJudgeResult> {
  if (input.candidates.length === 0) return { decisions: [] };

  // The judge system base is externalized in resources/prompts/autopilot-judge.md; project rules (AGENTS.md body) are appended as needed.
  const system = [
    fillTemplate(PROMPT_TEMPLATES.autopilotJudge, {}),
    input.agentsRules?.trim()
      ? `\nProject rules (may add skip exceptions):\n${input.agentsRules.trim()}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const list = input.candidates
    .map((c, i) => {
      // Branch merge signals are listed as **evidence** (not a verdict): the judge weighs them + title/description to decide if worth reviewing.
      const signals: string[] = [];
      if (c.branchMerge) signals.push('all commits are merge commits (likely a branch sync / back-merge)');
      if (c.sourceMainline) signals.push('source is a long-lived / integration branch');
      const branch =
        c.sourceBranch && c.targetBranch
          ? `\nbranches: ${c.sourceBranch} -> ${c.targetBranch}${signals.length ? `\nsignals: ${signals.join('; ')}` : ''}`
          : '';
      return `${String(i + 1)}. [id:${c.prLocalId}] ${c.title}${branch}\n${(c.description ?? '').trim().slice(0, DESC_CLAMP)}`;
    })
    .join('\n\n');

  const user = [
    'For each PR decide review (true) or skip (false) with a short reason; optionally add a custom step "plan" (see system).',
    'Reply with JSON only: {"decisions": [{"prLocalId": string, "review": boolean, "reason": string, "plan"?: string[]}]}.',
    '',
    list,
  ].join('\n');

  const r = await chat({ system, user });
  const parsed = extractJson<{
    decisions?: Array<{ prLocalId?: unknown; review?: unknown; reason?: unknown; plan?: unknown }>;
  }>(r.text);

  const byId = new Map<string, JudgeDecision>();
  for (const d of parsed?.decisions ?? []) {
    if (typeof d.prLocalId === 'string') {
      // Invalid / omitted plan → undefined (review uses the default full set); only attached if valid, passed through by autopilot to the micro-flow.
      const plan = parseReviewPlan(d.plan);
      byId.set(d.prLocalId, {
        prLocalId: d.prLocalId,
        // Omitted / not explicitly false → review (conservative: better to over-review than to miss)
        review: d.review !== false,
        reason: typeof d.reason === 'string' ? d.reason : '',
        ...(plan ? { plan } : {}),
      });
    }
  }

  // Candidates missing from the parse default to review, ensuring every candidate has a decision.
  const decisions = input.candidates.map(
    (c) =>
      byId.get(c.prLocalId) ?? {
        prLocalId: c.prLocalId,
        review: true,
        reason: 'default (unparsed)',
      },
  );
  return { decisions, usage: r.usage };
}
