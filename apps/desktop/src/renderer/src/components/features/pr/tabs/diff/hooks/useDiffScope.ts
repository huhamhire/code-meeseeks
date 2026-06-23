import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PrCommit, StoredPullRequest } from '@meebox/shared';
import { invoke } from '../../../../../../api';
import type { DiffScope, PendingCommitView } from '../diff-types';

export interface DiffScopeState {
  scope: DiffScope;
  setScope: (scope: DiffScope) => void;
  /** 范围下拉用的 commit 列表（懒加载：首次展开下拉才拉） */
  scopeCommits: PrCommit[] | null;
  loadScopeCommits: () => void;
  /** 当前视图标识 = PR + 范围。切 PR 或切范围都视为内容换新，驱动 stale-while-loading。 */
  viewKey: string;
  /** commit 视图的 diff 范围（parent..sha）；'all' 或 root commit（无 parent）为 null → 走 PR 默认范围。 */
  range: { base: string; head: string } | null;
}

/**
 * diff 变更范围状态：全部变更 / 单个 commit。含切 PR 复位、消费外部「查看特定 commit」请求、
 * 懒加载范围下拉的 commit 列表。
 */
export function useDiffScope(
  pr: StoredPullRequest,
  pendingCommitView: PendingCommitView | null | undefined,
  onCommitViewConsumed: (() => void) | undefined,
): DiffScopeState {
  // 变更范围：全部变更 / 单个 commit。commit 视图为只读 diff（见 DiffScope）。
  const [scope, setScope] = useState<DiffScope>({ kind: 'all' });
  // 范围下拉用的 commit 列表（懒加载：首次展开下拉才拉）。
  const [scopeCommits, setScopeCommits] = useState<PrCommit[] | null>(null);
  const viewKey = useMemo(
    () => (scope.kind === 'all' ? `${pr.localId}|all` : `${pr.localId}|c:${scope.sha}`),
    [pr.localId, scope],
  );
  const range = useMemo(
    () =>
      scope.kind === 'commit' && scope.parent ? { base: scope.parent, head: scope.sha } : null,
    [scope],
  );
  const loadScopeCommits = useCallback(() => {
    setScopeCommits((prev) => {
      if (prev !== null) return prev;
      void invoke('diff:listCommits', { localId: pr.localId })
        .then((cs) => setScopeCommits(cs))
        .catch(() => setScopeCommits([]));
      return prev;
    });
  }, [pr.localId]);

  // 切 PR 回到「全部变更」范围，并丢弃旧 PR 的范围下拉 commit 列表
  useEffect(() => {
    setScope({ kind: 'all' });
    setScopeCommits(null);
  }, [pr.localId]);

  // 消费外部「查看特定 commit」请求（提交 / 活动标签页点击 commit）→ 切到该 commit 范围。
  useEffect(() => {
    if (!pendingCommitView) return;
    setScope({
      kind: 'commit',
      sha: pendingCommitView.sha,
      parent: pendingCommitView.parent,
      abbreviatedSha: pendingCommitView.abbreviatedSha,
      subject: pendingCommitView.subject,
    });
    onCommitViewConsumed?.();
  }, [pendingCommitView, onCommitViewConsumed]);

  return { scope, setScope, scopeCommits, loadScopeCommits, viewKey, range };
}
