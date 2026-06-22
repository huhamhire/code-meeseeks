import { Step } from '../context.js';
import type { ReviewStepCtx } from './shared.js';

/**
 * 生成代码改进建议（只读 /improve）。先把本步思考流式出去（思考在前），再派发工具；建议以
 * code-suggestion findings 经各自 run 卡片呈现（parseReviewOutput 对 tool='improve' 走专门解析），
 * 故无需回填 bag。**默认计划不含本步**——仅当规则给出的计划纳入 `improve` 时才执行。
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
