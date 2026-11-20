import type { StoredPullRequest } from '@meebox/shared';

export interface CommitTimelineEntry {
  key: string;
  sortTime: number;
  headSha?: string;
  completedReview?: boolean;
  orchestratedReview?: boolean;
  reviewStartedAt?: number;
  reviewSummary?: boolean;
}

export interface CommitDividers {
  before: Map<string, string[]>;
  bottom: string[];
}

/** Observed transitions keep their timestamp. Infer older boundaries from revision-bearing history. */
export function computeCommitDividers(
  timeline: readonly CommitTimelineEntry[],
  headSha: string | undefined,
  changes: StoredPullRequest['headChanges'] = [],
  agentRunning = false,
): CommitDividers {
  const before = new Map<string, string[]>();
  const bottom: string[] = [];
  const firstReview = timeline.find((entry) => entry.completedReview);
  if (!firstReview) return { before, bottom };

  const reviews: Array<{ start: number; summaryIndex: number }> = [];
  let legacyReviewStart: number | undefined;
  let incompleteReview: { start: number; lastStepIndex: number } | undefined;
  timeline.forEach((entry, index) => {
    if (entry.orchestratedReview) legacyReviewStart ??= entry.sortTime;
    if (!entry.reviewSummary) {
      if (entry.reviewStartedAt !== undefined) {
        incompleteReview = { start: entry.reviewStartedAt, lastStepIndex: index };
      }
      return;
    }
    const start = entry.reviewStartedAt ?? legacyReviewStart;
    if (start !== undefined) {
      reviews.push({ start, summaryIndex: index });
      if (incompleteReview?.start === start) incompleteReview = undefined;
    }
    legacyReviewStart = undefined;
  });

  const add = (index: number, sha: string, time: number) => {
    // A commit observed while an automatic review is in progress belongs after its conclusion.
    if (incompleteReview && time >= incompleteReview.start) {
      if (agentRunning) return;
      index = Math.max(index, incompleteReview.lastStepIndex + 1);
    }
    for (const { start, summaryIndex } of reviews) {
      const summary = timeline[summaryIndex];
      if (summary && time >= start && time <= summary.sortTime) {
        index = Math.max(index, summaryIndex + 1);
      }
    }
    const entry = timeline[index];
    if (!entry) {
      bottom.push(sha);
      return;
    }
    const current = before.get(entry.key);
    if (current) current.push(sha);
    else before.set(entry.key, [sha]);
  };
  const observed = changes
    .map(({ sha, at }) => ({ sha, time: Date.parse(at) }))
    .filter(({ time }) => Number.isFinite(time) && time > firstReview.sortTime)
    .sort((a, b) => a.time - b.time);

  let previousSha: string | undefined;
  let previousIndex = -1;
  const firstObserved = observed[0]?.time ?? Number.POSITIVE_INFINITY;
  timeline.forEach((entry, index) => {
    if (
      entry.sortTime < firstReview.sortTime ||
      entry.sortTime >= firstObserved ||
      !entry.headSha
    ) {
      return;
    }
    if (previousSha && previousSha !== entry.headSha) {
      add(
        previousIndex + 1,
        entry.headSha,
        timeline[previousIndex + 1]?.sortTime ?? entry.sortTime,
      );
    }
    previousSha = entry.headSha;
    previousIndex = index;
  });

  for (const change of observed) {
    const index = timeline.findIndex((entry) => entry.sortTime >= change.time);
    add(index === -1 ? timeline.length : index, change.sha, change.time);
  }
  if (!observed.length && headSha && previousSha && headSha !== previousSha) {
    add(
      previousIndex + 1,
      headSha,
      timeline[previousIndex + 1]?.sortTime ?? Number.POSITIVE_INFINITY,
    );
  }
  return { before, bottom };
}
