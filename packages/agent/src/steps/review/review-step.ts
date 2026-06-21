import { Step } from '../context.js';
import type { ReviewStepCtx } from './shared.js';

/**
 * 生成代码评审发现（只读 /review）。先把本步思考流式出去（思考在前），工具执行进度 / 计时由 run 卡片承载。
 */
export class ReviewStep extends Step<ReviewStepCtx> {
  readonly name = 'review';

  async run(ctx: ReviewStepCtx): Promise<void> {
    ctx.checkAbort();
    await ctx.rec.record({ kind: 'plan', thought: ctx.labels.review, toolCall: { tool: 'review' } });
    const review = await ctx.deps.runTool({ tool: 'review' });
    ctx.rec.track(review.usage);
    ctx.bag.review = review;
  }
}
