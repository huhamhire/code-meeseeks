import { runStaggered } from '../../stagger.js';
import { Step } from '../context.js';
import type { ReviewStepCtx } from './shared.js';

/** 多个追问同属一个阶段、彼此独立，故并行派发（runStaggered 保序、错开起跑；questions 为空不触发）。 */
export class AsksStep extends Step<ReviewStepCtx> {
  readonly name = 'asks';

  async run(ctx: ReviewStepCtx): Promise<void> {
    ctx.checkAbort();
    const { questions } = ctx.bag;
    const asks = questions.length
      ? await runStaggered(questions, (q) => ctx.deps.runTool({ tool: 'ask', question: q }))
      : [];
    ctx.bag.askResults = asks.map((ask, i) => {
      ctx.rec.track(ask.usage);
      return `Q: ${questions[i]}\nA: ${ask.text}`;
    });
  }
}
