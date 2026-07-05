import type { AgentRecommendation } from '@meebox/shared';
import { SUMMARY_MAX_OUTPUT_TOKENS } from '../../constants.js';
import { DEFAULT_SUMMARY_SECTIONS } from '../../orchestrator.js';
import { extractTrailingJson, salvageProse, stripTrailingJson } from '../../utils/index.js';
import { Step } from '../context.js';
import { isVerdict, summaryPrompt, type ReviewStepCtx } from './shared.js';

/**
 * Summary + suggestion. The model outputs "plain markdown body + a one-line verdict JSON at the end" (see summary.md): the body goes through
 * stripTrailingJson to strip the trailing verdict (with a fallback for truncated dangling JSON), the verdict is parsed separately via extractTrailingJson.
 * No longer stuffing the whole markdown into a JSON string — avoids quotes/newlines in the body breaking JSON parsing and getting cut off on parse failure.
 * Give a generous output token cap to avoid the provider's default cap truncating the body.
 */
export class SummaryStep extends Step<ReviewStepCtx> {
  readonly name = 'summary';

  async run(ctx: ReviewStepCtx): Promise<void> {
    ctx.checkAbort();
    const sumStart = Date.now();
    const sum = await ctx.deps.chat({
      system: ctx.system,
      user: summaryPrompt(
        ctx.bag.describe!.text,
        ctx.bag.review!.text,
        ctx.bag.askResults,
        ctx.summaryMax,
        ctx.input.summarySections ?? DEFAULT_SUMMARY_SECTIONS,
      ),
      maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    });
    const sumMs = Date.now() - sumStart;
    ctx.rec.track(sum.usage);
    // Fallback: if the model still wraps the whole thing in a JSON string (against the prompt), stripTrailingJson strips the whole object to empty → use
    // salvageProse to recover the body from the "summary"/"final" field.
    const summary = stripTrailingJson(sum.text).trim() || salvageProse(sum.text).trim();
    // Trailing verdict: the new format is a flat {verdict,reason}; compatible with the legacy format (the nested recommendation field of a whole JSON object).
    const obj = extractTrailingJson<{
      verdict?: unknown;
      reason?: unknown;
      recommendation?: { verdict?: unknown; reason?: unknown };
    }>(sum.text);
    const rec = obj?.recommendation ?? obj;
    // Verdict parse failure → manual_review with no reason: this fallback has no value to the user, the frontend hides the grey text on an empty reason (no longer outputting
    // "failed to parse suggestion, switching to manual review"). A valid manual_review reason from the model is still displayed as usual.
    const recommendation: AgentRecommendation =
      rec && isVerdict(rec.verdict)
        ? { verdict: rec.verdict, reason: typeof rec.reason === 'string' ? rec.reason : '' }
        : { verdict: 'manual_review', reason: '' };
    ctx.bag.summary = summary;
    ctx.bag.recommendation = recommendation;
    await ctx.rec.record({
      kind: 'plan',
      thought: ctx.labels.summary,
      result: summary,
      thinkMs: sumMs,
      usage: sum.usage,
    });
  }
}
