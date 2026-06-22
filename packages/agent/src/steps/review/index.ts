import type { Step } from '../context.js';
import { AsksStep } from './asks-step.js';
import { DescribeReviewStep } from './describe-review-step.js';
import { ImproveStep } from './improve-step.js';
import { JudgeStep } from './judge-step.js';
import type { ReviewStepCtx } from './shared.js';
import { SummaryStep } from './summary-step.js';

export type { ReviewBag, ReviewStepCtx } from './shared.js';

/**
 * 评审微流程可用步骤的稳定标识（与各 step.name 对应）。一份评审计划即由这些 kind 有序组成。
 * 新增工具步 = 在 REVIEW_STEP_REGISTRY 登记 + 在此并上 kind，驱动与默认计划无需改动。
 */
export type ReviewStepKind = 'describe-review' | 'improve' | 'judge' | 'asks' | 'summary';

/**
 * 评审微流程执行计划：一组**有序**步骤 kind。AutoPilot 后续可据用户 agent 上下文规则给出自定义计划
 * （跳过 / 重排 / 增删步骤）；手动评审恒用 DEFAULT_REVIEW_PLAN。计划来源（规则 → 计划）是后续工作，
 * 本层只提供「按计划组装并执行」的基础能力。
 */
export interface ReviewPlan {
  steps: ReviewStepKind[];
}

/** 步骤注册表（kind → 无状态单例）。各 step 运行态全在 ctx，故单例可复用。 */
export const REVIEW_STEP_REGISTRY: Record<ReviewStepKind, Step<ReviewStepCtx>> = {
  'describe-review': new DescribeReviewStep(),
  improve: new ImproveStep(),
  judge: new JudgeStep(),
  asks: new AsksStep(),
  summary: new SummaryStep(),
};

/** 默认计划：与拆 plan 前的固定序列完全一致（describe-review → judge → asks → summary）。 */
export const DEFAULT_REVIEW_PLAN: ReviewPlan = {
  steps: ['describe-review', 'judge', 'asks', 'summary'],
};

/**
 * 计划合法性：① 非空；② 各 kind 须在注册表内；③ judge / summary 读 describe·review 的产物（bag.describe /
 * bag.review），故计划含二者时必须先含 describe-review。非法计划由驱动回落 DEFAULT_REVIEW_PLAN
 * （见 runReviewMicroflow），避免规则给出坏计划时崩在步骤里。
 */
export function isValidReviewPlan(plan: ReviewPlan): boolean {
  if (plan.steps.length === 0) return false;
  if (plan.steps.some((k) => !(k in REVIEW_STEP_REGISTRY))) return false;
  const set = new Set<ReviewStepKind>(plan.steps);
  if ((set.has('judge') || set.has('summary')) && !set.has('describe-review')) return false;
  return true;
}

/** 把计划组装成有序步骤实例（驱动据此顺序执行）。调用方须先经 isValidReviewPlan 校验。 */
export function assembleReviewSteps(plan: ReviewPlan): Step<ReviewStepCtx>[] {
  return plan.steps.map((k) => REVIEW_STEP_REGISTRY[k]);
}
