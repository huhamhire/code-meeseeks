import type { Finding, FindingClosure, ReviewRun } from '@meebox/shared';
import type { TimelineEntry } from '../hooks/useChatTimeline';

interface ReviewFeedback {
  run: ReviewRun;
  findings: Finding[];
}

export function getReviewPresentation(
  timeline: readonly TimelineEntry[],
  closures: readonly FindingClosure[],
  dividers: ReadonlyMap<string, string[]>,
) {
  const summaries = timeline.filter(
    (entry) => entry.reviewSummary && entry.reviewStartedAt !== undefined,
  );
  const byStart = new Map(summaries.map((summary) => [summary.reviewStartedAt, summary]));
  const feedbackAt = new Map<string, ReviewFeedback[]>();
  const processAt = new Map<string, TimelineEntry[]>();
  const processMembers = new Set<string>();
  const movedFindings = new Map<string, ReadonlySet<string>>();
  const superseded = new Set(
    closures
      .filter(({ verdict }) => verdict === 'replace' || verdict === 'drop')
      .map(({ runId, findingId }) => JSON.stringify([runId, findingId])),
  );
  let summaryIndex = 0;
  let previousSummary: TimelineEntry | undefined;
  let segment: TimelineEntry[] = [];

  for (const [index, entry] of timeline.entries()) {
    while (summaries[summaryIndex] && summaries[summaryIndex].sortTime < entry.sortTime) {
      summaryIndex += 1;
    }
    let summary = byStart.get(entry.reviewStartedAt);
    // Older records have an agent origin but no run-level session marker.
    if (!summary && entry.reviewStartedAt === undefined && entry.run?.origin === 'agent') {
      const candidate = summaries[summaryIndex];
      if (
        candidate &&
        entry.sortTime >= candidate.reviewStartedAt! &&
        (!entry.headSha || !candidate.headSha || entry.headSha === candidate.headSha) &&
        !entry.run.scope &&
        Date.parse(entry.run.finishedAt ?? '') <= candidate.sortTime
      )
        summary = candidate;
    }
    const nextRun = timeline[index + 1]?.run;
    if (
      entry.reviewSummary ||
      entry.run?.tool === 'describe' ||
      (entry.step?.kind === 'plan' && nextRun?.origin === 'agent' && nextRun.tool === 'describe') ||
      !summary ||
      entry.sortTime > summary.sortTime ||
      (!entry.step && entry.run?.status !== 'succeeded')
    ) {
      previousSummary = undefined;
      continue;
    }
    if (summary !== previousSummary || dividers.has(entry.key)) {
      segment = [];
      processAt.set(entry.key, segment);
    }
    segment.push(entry);
    processMembers.add(entry.key);
    previousSummary = summary;

    const run = entry.run;
    if (!run) continue;
    const findings = (run.findings ?? []).filter((finding) => {
      const kind = finding.sectionKey ?? finding.category;
      return (
        (kind === 'code-feedback' || kind === 'code-suggestion') &&
        !superseded.has(JSON.stringify([run.id, finding.id]))
      );
    });
    if (!findings.length) continue;
    movedFindings.set(run.id, new Set(findings.map(({ id }) => id)));
    const existing = feedbackAt.get(summary.key) ?? [];
    existing.push({ run, findings });
    feedbackAt.set(summary.key, existing);
  }
  return { feedbackAt, processAt, processMembers, movedFindings };
}
