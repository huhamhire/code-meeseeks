import { runStaggered } from '../../utils/index.js';
import { Step } from '../context.js';
import type { ReviewStepCtx } from './shared.js';

/**
 * 多个追问同属一个阶段、彼此独立，故并行派发（runStaggered 保序、错开起跑；asks 为空不触发）。
 *
 * PR3 复评关联：judge 点名了 review finding（targetFindingId）的追问，以**复评模式**派发——携带被复评
 * finding 的正文（referencedContext）+ 结构化引用（referencedFinding），run 卡片即出「复评自」徽标 + 裁决；
 * 裁决 replace/drop 时自动关闭被取代的原 review finding（closeFinding，建立 FindingClosure）。keep / 未点名
 * 不动。新评论不自动落草稿——留待用户在复评卡手动「采纳」（与手动引用路径一致）。
 */
export class AsksStep extends Step<ReviewStepCtx> {
  readonly name = 'asks';

  async run(ctx: ReviewStepCtx): Promise<void> {
    ctx.checkAbort();
    const { asks } = ctx.bag;
    const reviewRunId = ctx.bag.review?.runId;
    const findings = ctx.bag.review?.findings ?? [];
    const results = asks.length
      ? await runStaggered(asks, (a) => {
          // 命中点名 + 该 finding 存在且可锚定 → 复评模式（携引用上下文 + 前向链）。
          const target =
            a.targetFindingId && reviewRunId
              ? findings.find(
                  (f) => f.id === a.targetFindingId && f.anchor?.startLine !== undefined,
                )
              : undefined;
          if (target && reviewRunId) {
            return ctx.deps.runTool({
              tool: 'ask',
              question: a.question,
              referencedContext: `An existing review comment on \`${target.anchor!.path}\` is being re-evaluated:\n\n${target.body}`,
              referencedFinding: {
                runId: reviewRunId,
                findingId: target.id,
                anchor: target.anchor,
              },
            });
          }
          return ctx.deps.runTool({ tool: 'ask', question: a.question });
        })
      : [];
    // 复评裁决 replace/drop → 自动关闭被取代的原 review finding（建立 FindingClosure）。
    for (let i = 0; i < results.length; i += 1) {
      const ask = results[i]!;
      const targetId = asks[i]!.targetFindingId;
      ctx.rec.track(ask.usage);
      if (
        targetId &&
        reviewRunId &&
        ask.runId &&
        (ask.askVerdict === 'replace' || ask.askVerdict === 'drop')
      ) {
        await ctx.deps.closeFinding?.({
          runId: reviewRunId,
          findingId: targetId,
          byAskRunId: ask.runId,
          verdict: ask.askVerdict,
        });
      }
    }
    // 喂给总结的只取追问的「结论」(ask-summary)，不灌全文——/ask 现产出富文本分析 / 表格 / 代码块 /
    // 逐条代码建议，整段灌进去会撑爆总结、诱导模型照搬单条追问的细节，背离「总结=PR 整体结论」的初衷。
    ctx.bag.askResults = results.map((ask, i) => {
      const conclusion =
        ask.findings?.find((f) => f.sectionKey === 'ask-summary')?.body?.trim() || ask.text.trim();
      return `Q: ${asks[i]!.question}\nA: ${conclusion}`;
    });
  }
}
