import type { AgentRecommendation } from '@meebox/shared';
import { SUMMARY_MAX_OUTPUT_TOKENS } from '../../constants.js';
import { DEFAULT_SUMMARY_SECTIONS } from '../../orchestrator.js';
import { extractTrailingJson, salvageProse, stripTrailingJson } from '../../utils/index.js';
import { Step } from '../context.js';
import { isVerdict, summaryPrompt, type ReviewStepCtx } from './shared.js';

/**
 * 收尾总结 + 建议。模型输出「纯 markdown 正文 + 末尾一行判定 JSON」（见 summary.md）：正文走
 * stripTrailingJson 剥掉末尾判定（含被截断的 dangling JSON 兜底），判定走 extractTrailingJson 单独解析。
 * 不再把整段 markdown 塞进 JSON 字符串——避免正文里的引号/换行破坏 JSON 解析、并在解析失败时被腰斩。
 * 给足输出 token 上限，避免 provider 默认上限截断正文。
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
    // 兜底：模型若仍把整段包进 JSON 字符串（违背 prompt），stripTrailingJson 会把整个对象剥空 → 用
    // salvageProse 从 "summary"/"final" 字段捞回正文。
    const summary = stripTrailingJson(sum.text).trim() || salvageProse(sum.text).trim();
    // 末尾判定：新格式是扁平 {verdict,reason}；兼容旧格式（整体 JSON 的嵌套 recommendation 字段）。
    const obj = extractTrailingJson<{
      verdict?: unknown;
      reason?: unknown;
      recommendation?: { verdict?: unknown; reason?: unknown };
    }>(sum.text);
    const rec = obj?.recommendation ?? obj;
    // 判定解析失败 → 转人工复核、不带理由：该兜底对用户无价值，前端按空 reason 隐藏灰字（不再输出
    // 「无法解析建议，转人工复核」）。模型给出的合法 manual_review 理由仍照常展示。
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
