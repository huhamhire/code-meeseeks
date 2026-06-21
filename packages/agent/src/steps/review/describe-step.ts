import { Step } from '../context.js';
import type { ReviewStepCtx } from './shared.js';

/**
 * 生成 PR 描述（只读 /describe）。类 Claude Code：先把本步思考流式出去（思考在前），工具执行进度 / 计时
 * 由 run 卡片承载，不为工具补记 tool 步。
 */
export class DescribeStep extends Step<ReviewStepCtx> {
  readonly name = 'describe';

  async run(ctx: ReviewStepCtx): Promise<void> {
    ctx.checkAbort();
    await ctx.rec.record({ kind: 'plan', thought: ctx.labels.describe, toolCall: { tool: 'describe' } });
    const describe = await ctx.deps.runTool({ tool: 'describe' });
    ctx.rec.track(describe.usage);
    ctx.bag.describe = describe;
  }
}
