import type { Finding, FindingClosure, ReviewRun } from '@meebox/shared';
import type { TimelineEntry } from '../hooks/useChatTimeline';
import { htmlInlineToMarkdown, stripFindingMarker } from './findings';

interface ReviewFeedback {
  run: ReviewRun;
  findings: Finding[];
}

interface FeedbackEntry {
  run: ReviewRun;
  finding: Finding;
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
  const feedbackBySummary = new Map<string, Map<string, FeedbackEntry | null>>();
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
    const unique = feedbackBySummary.get(summary.key) ?? new Map<string, FeedbackEntry | null>();
    feedbackBySummary.set(summary.key, unique);
    for (const finding of run.findings ?? []) {
      const kind = finding.sectionKey ?? finding.category;
      if (kind !== 'code-feedback' && kind !== 'code-suggestion') continue;
      const { path, startLine, endLine } = finding.anchor ?? {};
      const body = htmlInlineToMarkdown(stripFindingMarker(finding.body))
        .replace(/\r\n/g, '\n')
        .trim();
      const key = JSON.stringify([
        run.headSha,
        run.baseSha,
        path,
        startLine,
        endLine ?? startLine,
        body,
        finding.codeChange?.existing,
        finding.codeChange?.improved,
      ]);
      // A closure also removes exact duplicates of the closed feedback in this review.
      if (superseded.has(JSON.stringify([run.id, finding.id]))) {
        unique.set(key, null);
      } else if (!unique.has(key)) {
        unique.set(key, { run, finding });
      }
    }
  }
  for (const [summaryKey, unique] of feedbackBySummary) {
    const byRun = new Map<string, ReviewFeedback>();
    for (const entry of unique.values()) {
      if (!entry) continue;
      const { run, finding } = entry;
      const group = byRun.get(run.id) ?? { run, findings: [] };
      group.findings.push(finding);
      byRun.set(run.id, group);
    }
    if (byRun.size) feedbackAt.set(summaryKey, [...byRun.values()]);
  }
  return { feedbackAt, processAt, processMembers };
}
