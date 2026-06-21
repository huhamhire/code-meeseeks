import { runStaggered } from '../../utils/index.js';
import { Step } from '../context.js';
import type { ReviewStepCtx } from './shared.js';

/**
 * 并行生成 PR 描述（只读 /describe）与代码评审发现（只读 /review）：二者彼此独立、都只读 PR、无先后依赖，
 * 故并发分发（runStaggered 错开起跑避免抢占子进程 spawn / LLM 网络，保序、不改并发语义；实际并发仍受运行
 * 队列 max_concurrency 约束）。类 Claude Code：先把两步思考依次流式出去（思考在前），再并行执行；工具执行
 * 进度 / 计时由 run 卡片承载，不为工具补记 tool 步。
 */
export class DescribeReviewStep extends Step<ReviewStepCtx> {
  readonly name = 'describe-review';

  async run(ctx: ReviewStepCtx): Promise<void> {
    ctx.checkAbort();
    await ctx.rec.record({
      kind: 'plan',
      thought: ctx.labels.describe,
      toolCall: { tool: 'describe' },
    });
    await ctx.rec.record({ kind: 'plan', thought: ctx.labels.review, toolCall: { tool: 'review' } });
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
