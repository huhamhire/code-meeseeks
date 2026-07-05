import { useEffect, useState } from 'react';
import type { PrComment, StoredPullRequest } from '@meebox/shared';
import { invoke, subscribe } from '../../../../../../api';
import { formatBackendError, type FormattedError } from '../../../../../../errors';

export interface DiffCommentsState {
  comments: PrComment[];
  commentsError: FormattedError | null;
  retryComments: () => void;
  setCommentsError: (v: FormattedError | null) => void;
}

/**
 * Fetch PR comments (inline + summary). Force a remote fetch once after open / scope switch; subscribe to comments:changed to refetch.
 * The commit read-only view doesn't show inline comments (they anchor to the PR full-diff line numbers, so applying them to a single commit misaligns).
 */
export function useDiffComments(
  pr: StoredPullRequest,
  scopeKind: 'all' | 'commit',
  loadedKey: string | null,
  viewKey: string,
): DiffCommentsState {
  const [comments, setComments] = useState<PrComment[]>([]);
  const [commentsError, setCommentsError] = useState<FormattedError | null>(null);
  const [commentsRetry, setCommentsRetry] = useState(0);

  useEffect(() => {
    // Gate: during PR switch (new files not yet arrived) don't fetch new comments, keep old comments rendering consistent with old content, avoid view zone misalignment.
    if (loadedKey !== viewKey) return;
    // commit read-only view: inline comments anchor to the PR full-diff line numbers, applying them to a single commit version misaligns, so don't show.
    if (scopeKind !== 'all') {
      setComments([]);
      return;
    }
    let cancelled = false;
    setCommentsError(null);
    const fetchList = (force: boolean): void => {
      invoke('diff:listComments', { localId: pr.localId, force })
        .then((cs) => {
          if (!cancelled) setComments(cs);
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            const fmt = formatBackendError(e);
            console.warn('diff:listComments failed', e);
            setCommentsError(fmt);
          }
        });
    };
    fetchList(true);
    // After a comment reply / status change the main process broadcasts comments:changed, the inline view zone
    // needs to refetch to refresh the comment tree (including new replies nested into the parent comment's .replies)
    const unsub = subscribe('comments:changed', (e) => {
      if (e.localId === pr.localId) fetchList(true);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [pr.localId, commentsRetry, loadedKey, viewKey, scopeKind]);

  return {
    comments,
    commentsError,
    retryComments: () => setCommentsRetry((n) => n + 1),
    setCommentsError,
  };
}
