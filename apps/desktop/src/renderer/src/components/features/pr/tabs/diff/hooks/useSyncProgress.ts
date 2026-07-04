import { useEffect, useState } from 'react';
import type { StoredPullRequest, SyncProgressEvent } from '@meebox/shared';

/** Subscribes to sync:progress and filters by the repo the current PR belongs to; clears old progress on PR switch. */
export function useSyncProgress(pr: StoredPullRequest): SyncProgressEvent | null {
  const [progress, setProgress] = useState<SyncProgressEvent | null>(null);
  const repoKeySuffix = `/${pr.repo.projectKey}/${pr.repo.repoSlug}`;
  useEffect(() => {
    const unsubscribe = window.api.subscribe('sync:progress', (event) => {
      if (event.repo.endsWith(repoKeySuffix)) setProgress(event);
    });
    return unsubscribe;
  }, [repoKeySuffix]);
  // PR switch only clears transient progress (does not clear files/content etc., keeping the stale-while-loading old view)
  useEffect(() => {
    setProgress(null);
  }, [pr.localId]);
  return progress;
}
