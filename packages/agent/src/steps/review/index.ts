import type { Step } from '../context.js';
import { AsksStep } from './asks-step.js';
import { DescribeReviewStep } from './describe-review-step.js';
import { ImproveStep } from './improve-step.js';
import { JudgeStep } from './judge-step.js';
import type { ReviewStepCtx } from './shared.js';
import { SummaryStep } from './summary-step.js';

export type { ReviewBag, ReviewStepCtx } from './shared.js';

/**
 * Stable identifiers for the review microflow's available steps (corresponding to each step.name). A review plan is composed of these kinds in order.
 * Adding a tool step = register it in REVIEW_STEP_REGISTRY + add its kind here; the driver and default plan need no changes.
 */
export type ReviewStepKind = 'describe-review' | 'improve' | 'judge' | 'asks' | 'summary';

/**
 * Review microflow execution plan: a set of **ordered** step kinds. AutoPilot may later give a custom plan
 * (skip / reorder / add/remove steps) based on user agent context rules; manual review always uses DEFAULT_REVIEW_PLAN. The plan source (rules → plan) is future work,
 * this layer only provides the base capability of "assemble and execute by plan".
 */
export interface ReviewPlan {
  steps: ReviewStepKind[];
}

/** Step registry (kind → stateless singleton). Each step's runtime state lives entirely in ctx, so singletons are reusable. */
export const REVIEW_STEP_REGISTRY: Record<ReviewStepKind, Step<ReviewStepCtx>> = {
  'describe-review': new DescribeReviewStep(),
  improve: new ImproveStep(),
  judge: new JudgeStep(),
  asks: new AsksStep(),
  summary: new SummaryStep(),
};

/** Default plan: exactly the same fixed sequence as before the plan split (describe-review → judge → asks → summary). */
export const DEFAULT_REVIEW_PLAN: ReviewPlan = {
  steps: ['describe-review', 'judge', 'asks', 'summary'],
};

/**
 * Plan validity: (1) non-empty; (2) each kind must be in the registry; (3) judge / summary read describe·review's outputs (bag.describe /
 * bag.review), so a plan containing either must include describe-review first. Invalid plans fall back to DEFAULT_REVIEW_PLAN by the driver
 * (see runReviewMicroflow), avoiding a crash inside a step when a rule gives a bad plan.
 */
export function isValidReviewPlan(plan: ReviewPlan): boolean {
  if (plan.steps.length === 0) return false;
  if (plan.steps.some((k) => !(k in REVIEW_STEP_REGISTRY))) return false;
  const set = new Set<ReviewStepKind>(plan.steps);
  if ((set.has('judge') || set.has('summary')) && !set.has('describe-review')) return false;
  return true;
}

/** Assemble the plan into ordered step instances (the driver executes in this order). Callers must validate via isValidReviewPlan first. */
export function assembleReviewSteps(plan: ReviewPlan): Step<ReviewStepCtx>[] {
  return plan.steps.map((k) => REVIEW_STEP_REGISTRY[k]);
}
