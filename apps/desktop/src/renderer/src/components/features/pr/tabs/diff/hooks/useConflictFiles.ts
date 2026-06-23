import { useEffect, useState } from 'react';
import type { StoredPullRequest } from '@meebox/shared';
import { invoke } from '../../../../../../api';

/**
 * 拉「合并会冲突的文件」路径集合，供文件树标三角警示。仅当远端判定 PR 有冲突（pr.hasConflict）时才打
 * 后端（后端再跑本地 merge-tree 试合并）；无冲突直接给空集。失败保守返回空集（不标记，不报错）。
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
