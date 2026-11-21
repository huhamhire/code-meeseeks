import type { ReviewRun, StoredPullRequest } from '@meebox/shared';

export function isStaleReview(run: ReviewRun, pr: StoredPullRequest | null): boolean {
  if (run.tool === 'describe' || !pr) return false;
  return (
    (run.headSha !== undefined && run.headSha !== pr.sourceRef.sha) ||
    (run.baseSha !== undefined && run.baseSha !== pr.targetRef.sha)
  );
}
