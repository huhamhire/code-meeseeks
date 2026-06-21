import { JUDGE_MAX_OUTPUT_TOKENS, JUDGE_SYSTEM } from '../../constants.js';
import { extractJson } from '../../utils/index.js';
import { Step } from '../context.js';
import { judgePrompt, type ReviewStepCtx } from './shared.js';

/** 仅严重问题条件性追问的判读（精简 system 轻量路由 + 输出封顶）。 */
export class JudgeStep extends Step<ReviewStepCtx> {
  readonly name = 'judge';

  async run(ctx: ReviewStepCtx): Promise<void> {
    ctx.checkAbort();
    const judgeStart = Date.now();
    const judge = await ctx.deps.chat({
      system: JUDGE_SYSTEM,
      user: judgePrompt(
        ctx.bag.describe!.text,
        ctx.bag.review!.text,
        ctx.maxAsks,
        ctx.input.language ?? '',
      ),
      // 判读产物只是极小 JSON（severe + 至多数条问题），封顶输出避免对 yes/no 决策狂吐 token。
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
    });
    const judgeMs = Date.now() - judgeStart;
    ctx.rec.track(judge.usage);
    const verdict = extractJson<{ severe?: boolean; questions?: string[] }>(judge.text);
    const questions = verdict?.severe ? (verdict.questions ?? []).slice(0, ctx.maxAsks) : [];
    ctx.bag.questions = questions;
    await ctx.rec.record({
      kind: 'judge',
      thought: ctx.labels.judge,
      result: questions.length ? ctx.labels.judgeSevere(questions.length) : ctx.labels.judgeNone,
      thinkMs: judgeMs,
      usage: judge.usage,
    });
  }
}
