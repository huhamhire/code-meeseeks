import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PrCommit, StoredPullRequest } from '@meebox/shared';
import { invoke } from '../../../../../../api';
import type { DiffScope, PendingCommitView } from '../diff-types';

export interface DiffScopeState {
  scope: DiffScope;
  setScope: (scope: DiffScope) => void;
  /** Commit list for the scope dropdown (lazy-loaded: fetched only on first dropdown expand) */
  scopeCommits: PrCommit[] | null;
  loadScopeCommits: () => void;
  /** Current view identifier = PR + scope. Switching PR or scope is both treated as content refresh, driving stale-while-loading. */
  viewKey: string;
  /** commit view's diff range (parent..sha); 'all' or root commit (no parent) is null → uses the PR default range. */
  range: { base: string; head: string } | null;
}

/**
 * diff change scope state: all changes / a single commit. Includes PR-switch reset, consuming external "view a specific commit" requests,
 * and lazy-loading the commit list for the scope dropdown.
 */
export function useDiffScope(
  pr: StoredPullRequest,
  pendingCommitView: PendingCommitView | null | undefined,
  onCommitViewConsumed: (() => void) | undefined,
): DiffScopeState {
  // Change scope: all changes / a single commit. commit view is a read-only diff (see DiffScope).
  const [scope, setScope] = useState<DiffScope>({ kind: 'all' });
  // Commit list for the scope dropdown (lazy-loaded: fetched only on first dropdown expand).
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

  // On PR switch return to the "all changes" scope, and discard the old PR's scope-dropdown commit list
  useEffect(() => {
    setScope({ kind: 'all' });
    setScopeCommits(null);
  }, [pr.localId]);

  // Consume external "view a specific commit" requests (commit / activity tab clicking a commit) → switch to that commit's scope.
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
