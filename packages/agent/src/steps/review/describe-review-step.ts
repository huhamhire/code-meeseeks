import { runStaggered } from '../../utils/index.js';
import { Step } from '../context.js';
import type { ReviewStepCtx } from './shared.js';

/**
 * Generate the PR description (read-only /describe) and code review findings (read-only /review) in parallel: the two are independent, both read the PR read-only, with no ordering dependency,
 * so they're dispatched concurrently (runStaggered staggers start to avoid contending on child-process spawn / LLM network, preserves order, doesn't change concurrency semantics; actual concurrency is still bounded by the run
 * queue's max_concurrency). In the display they merge into **one** thought line (back to the single line before the step split, no longer one line each for describe / review);
 * tool execution progress / timing is carried by each run card, no extra tool step is recorded for the tools.
 */
export class DescribeReviewStep extends Step<ReviewStepCtx> {
  readonly name = 'describe-review';

  async run(ctx: ReviewStepCtx): Promise<void> {
    ctx.checkAbort();
    // One merged thought line (describe + review); the two read-only tools then run in parallel, each writing its result back into bag for judge / summary.
    await ctx.rec.record({ kind: 'plan', thought: ctx.labels.describeReview });
    const [describe, review] = await runStaggered(
      [{ tool: 'describe' as const }, { tool: 'review' as const }],
      (c) => ctx.deps.runTool(c),
    );
    ctx.rec.track(describe.usage);
    ctx.rec.track(review.usage);
    ctx.bag.describe = describe;
    ctx.bag.review = review;
  }
}
