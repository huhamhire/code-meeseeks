import { useEffect, useState } from 'react';
import type { StoredPullRequest } from '@meebox/shared';
import { invoke } from '../../../../../../api';

/**
 * Fetch the set of paths for "files that will conflict on merge", for the file tree to mark with a warning
 * triangle. Only hits the backend when the remote deems the PR conflicted (pr.hasConflict) (the backend then
 * runs a local merge-tree trial merge); no conflict returns an empty set directly. On failure conservatively returns an empty set (no marking, no error).
 */
export function useConflictFiles(pr: StoredPullRequest): Set<string> {
  const [paths, setPaths] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!pr.hasConflict) {
      setPaths(new Set());
      return;
    }
    let cancelled = false;
    invoke('diff:listConflictFiles', { localId: pr.localId })
      .then((list) => {
        if (!cancelled) setPaths(new Set(list));
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          console.warn('diff:listConflictFiles failed', e);
          setPaths(new Set());
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pr.localId, pr.hasConflict]);

  return paths;
}
