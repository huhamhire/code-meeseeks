import type { StoredPullRequest } from '@meebox/shared';

export interface CommitTimelineEntry {
  key: string;
  sortTime: number;
  headSha?: string;
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
): CommitDividers {
  const before = new Map<string, string[]>();
  const bottom: string[] = [];
  const add = (entry: CommitTimelineEntry | undefined, sha: string) => {
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
    .filter(({ time }) => Number.isFinite(time))
    .sort((a, b) => a.time - b.time);

  let previousSha: string | undefined;
  let previousIndex = -1;
  const firstObserved = observed[0]?.time ?? Number.POSITIVE_INFINITY;
  timeline.forEach((entry, index) => {
    if (entry.sortTime >= firstObserved || !entry.headSha) return;
    if (previousSha && previousSha !== entry.headSha) {
      add(timeline[previousIndex + 1], entry.headSha);
    }
    previousSha = entry.headSha;
    previousIndex = index;
  });

  for (const change of observed) {
    add(
      timeline.find((entry) => entry.sortTime >= change.time),
      change.sha,
    );
  }
  if (!observed.length && headSha && previousSha && headSha !== previousSha) {
    add(timeline[previousIndex + 1], headSha);
  }
  return { before, bottom };
}
