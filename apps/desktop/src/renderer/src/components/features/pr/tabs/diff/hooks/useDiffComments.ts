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
 * 拉 PR 评论（inline + summary）。打开 / 范围切换后强制远端拉一次；订阅 comments:changed 重拉。
 * commit 只读视图不展示行内评论（锚定在 PR 全量 diff 行号上，套到单 commit 会错位）。
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
    // 门控：切 PR 期间（新 files 未到）不拉新评论，保留旧评论与旧内容一致渲染，避免 view zone 错位。
    if (loadedKey !== viewKey) return;
    // commit 只读视图：行内评论锚定在 PR 全量 diff 行号上，套到单 commit 版本会错位，故不展示。
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
    // 评论 reply / 状态变更后 main 端 broadcast comments:changed，inline view zone
    // 需要重拉刷新评论树 (含新 reply 嵌到父评论 .replies)
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
