import { useEffect, useState } from 'react';
import type { StoredPullRequest, SyncProgressEvent } from '@meebox/shared';

/** 订阅 sync:progress 并按当前 PR 所属 repo 过滤；切 PR 清旧进度。 */
export function useSyncProgress(pr: StoredPullRequest): SyncProgressEvent | null {
  const [progress, setProgress] = useState<SyncProgressEvent | null>(null);
  const repoKeySuffix = `/${pr.repo.projectKey}/${pr.repo.repoSlug}`;
  useEffect(() => {
    const unsubscribe = window.api.subscribe('sync:progress', (event) => {
      if (event.repo.endsWith(repoKeySuffix)) setProgress(event);
    });
    return unsubscribe;
  }, [repoKeySuffix]);
  // 切 PR 只清瞬态进度（不清 files/content 等，保留 stale-while-loading 旧视图）
  useEffect(() => {
    setProgress(null);
  }, [pr.localId]);
  return progress;
}
