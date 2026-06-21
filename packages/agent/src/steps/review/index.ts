import type { Step } from '../context.js';
import { AsksStep } from './asks-step.js';
import { DescribeReviewStep } from './describe-review-step.js';
import { JudgeStep } from './judge-step.js';
import type { ReviewStepCtx } from './shared.js';
import { SummaryStep } from './summary-step.js';

export type { ReviewBag, ReviewStepCtx } from './shared.js';

/** 评审微流程的步骤注册表（有序执行，无状态步骤以单例入表）。新增 / 调整阶段在此组合，驱动无需改动。 */
export const REVIEW_STEPS: ReadonlyArray<Step<ReviewStepCtx>> = [
  new DescribeReviewStep(),
  new JudgeStep(),
  new AsksStep(),
  new SummaryStep(),
];
