import { runStaggered } from '../../utils/index.js';
import { Step } from '../context.js';
import type { ReviewStepCtx } from './shared.js';

/**
 * Multiple follow-up asks belong to the same phase and are independent, so they're dispatched in parallel (runStaggered preserves order, staggers start; not triggered when asks is empty).
 *
 * PR3 re-evaluation link: a follow-up ask that judge named a review finding for (targetFindingId) is dispatched in **re-evaluation mode** — carrying the re-evaluated
 * finding's body (referencedContext) + structured reference (referencedFinding), so the run card shows a "re-evaluated from" badge + verdict;
 * on verdict replace/drop it auto-closes the superseded original review finding (closeFinding, establishing a FindingClosure). keep / unnamed
 * are left untouched. New comments don't auto-drop into drafts — left for the user to manually "adopt" on the re-evaluation card (consistent with the manual reference path).
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
          // named hit + the finding exists and is anchorable → re-evaluation mode (carries referenced context + forward link).
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
    // re-evaluation verdict replace/drop → auto-close the superseded original review finding (establishing a FindingClosure).
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
    // Feed the summary only the follow-up ask's "conclusion" (ask-summary), not the full text — /ask now produces rich-text analysis / tables / code blocks /
    // per-item code suggestions; dumping the whole thing in would bloat the summary and lure the model into copying a single ask's details, betraying the intent of "summary = the PR's overall conclusion".
    ctx.bag.askResults = results.map((ask, i) => {
      const conclusion =
        ask.findings?.find((f) => f.sectionKey === 'ask-summary')?.body?.trim() || ask.text.trim();
      return `Q: ${asks[i]!.question}\nA: ${conclusion}`;
    });
  }
}
