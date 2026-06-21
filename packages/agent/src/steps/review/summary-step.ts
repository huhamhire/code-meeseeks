import type { AgentRecommendation } from '@meebox/shared';
import { summarySections } from '../../orchestrator.js';
import { extractJson, salvageProse, stripTrailingJson } from '../../utils/index.js';
import { Step } from '../context.js';
import { isVerdict, summaryPrompt, type ReviewStepCtx } from './shared.js';

/** 收尾总结 + 建议。解析失败兜底打捞散文 + 剥末尾判定 JSON；**不做硬截断**。 */
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
        summarySections(ctx.input.language),
      ),
    });
    const sumMs = Date.now() - sumStart;
    ctx.rec.track(sum.usage);
    const parsed = extractJson<{
      summary?: string;
      recommendation?: { verdict?: unknown; reason?: unknown };
    }>(sum.text);
    const summary = stripTrailingJson(parsed?.summary ?? salvageProse(sum.text)).trim();
    const recommendation: AgentRecommendation =
      parsed?.recommendation && isVerdict(parsed.recommendation.verdict)
        ? {
            verdict: parsed.recommendation.verdict,
            reason:
              typeof parsed.recommendation.reason === 'string' ? parsed.recommendation.reason : '',
          }
        : { verdict: 'manual_review', reason: ctx.labels.parseFail };
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
