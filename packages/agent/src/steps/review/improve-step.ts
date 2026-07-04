import { Step } from '../context.js';
import type { ReviewStepCtx } from './shared.js';

/**
 * Generate code improvement suggestions (read-only /improve). First stream out this step's thought (thought first), then dispatch the tool; suggestions are
 * presented as code-suggestion findings via each run card (parseReviewOutput uses dedicated parsing for tool='improve'),
 * so there's no need to write back into bag. **The default plan doesn't include this step** — it runs only when a rule-provided plan includes `improve`.
 */
export class ImproveStep extends Step<ReviewStepCtx> {
  readonly name = 'improve';

  async run(ctx: ReviewStepCtx): Promise<void> {
    ctx.checkAbort();
    await ctx.rec.record({ kind: 'plan', thought: ctx.labels.improve });
    const result = await ctx.deps.runTool({ tool: 'improve' });
    ctx.rec.track(result.usage);
  }
}
