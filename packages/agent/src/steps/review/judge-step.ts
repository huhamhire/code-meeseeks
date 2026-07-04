import { JUDGE_MAX_OUTPUT_TOKENS, JUDGE_SYSTEM } from '../../constants.js';
import { extractJson } from '../../utils/index.js';
import { Step } from '../context.js';
import { judgePrompt, type ReviewStepCtx } from './shared.js';

/** Judge that conditionally follows up only on severe issues (lean system, lightweight routing + output cap). */
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
      // The judge output is tiny JSON (severe + at most a few follow-up asks, optionally with targetFindingId); cap output to avoid runaway token spend.
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
    });
    const judgeMs = Date.now() - judgeStart;
    ctx.rec.track(judge.usage);
    // New shape: asks:[{question, targetFindingId?}]; backward-compatible with legacy questions:string[] (mapped to no target).
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
