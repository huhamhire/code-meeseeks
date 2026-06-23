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
        ctx.bag.review?.findings ?? [],
        ctx.maxAsks,
        ctx.input.language ?? '',
      ),
      // 判读产物只是极小 JSON（severe + 至多数条追问，可带 targetFindingId），封顶输出避免狂吐 token。
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
    });
    const judgeMs = Date.now() - judgeStart;
    ctx.rec.track(judge.usage);
    // 新结构：asks:[{question, targetFindingId?}]；向后兼容旧 questions:string[]（映射为无 target）。
    const verdict = extractJson<{
      severe?: boolean;
      asks?: Array<{ question?: string; targetFindingId?: string }>;
      questions?: string[];
    }>(judge.text);
    const raw = verdict?.asks?.length
      ? verdict.asks.map((a) => ({
          question: a.question ?? '',
          targetFindingId: a.targetFindingId,
        }))
      : (verdict?.questions ?? []).map((q) => ({ question: q }));
    const asks = verdict?.severe ? raw.filter((a) => a.question.trim()).slice(0, ctx.maxAsks) : [];
    ctx.bag.asks = asks;
    await ctx.rec.record({
      kind: 'judge',
      thought: ctx.labels.judge,
      result: asks.length ? ctx.labels.judgeSevere(asks.length) : ctx.labels.judgeNone,
      thinkMs: judgeMs,
      usage: judge.usage,
    });
  }
}
