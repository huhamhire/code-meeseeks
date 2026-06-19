import { useEffect, useState } from 'react';
import type { StoredPullRequest } from '@meebox/shared';
import type { DiffChangedFile } from '@meebox/ipc';
import { invoke } from '../../../../../../api';
import { formatBackendError, type FormattedError } from '../../../../../../errors';
import type { LoadedContent } from '../diff-types';

export interface FileContentState {
  content: LoadedContent | null;
  contentLoading: boolean;
  contentError: FormattedError | null;
  setContentError: (v: FormattedError | null) => void;
}

/** 读取选中文件 base / head 两侧内容。切视图期间门控（loadedKey !== viewKey）保留旧内容。 */
export function useFileContent(
  pr: StoredPullRequest,
  selected: DiffChangedFile | null,
  range: { base: string; head: string } | null,
  loadedKey: string | null,
  viewKey: string,
): FileContentState {
  const [content, setContent] = useState<LoadedContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<FormattedError | null>(null);

  useEffect(() => {
    // 门控：切视图期间（新 files 未到、selected 仍指向旧文件）不拉内容，保留旧内容渲染，
    // 避免用「新视图 + 旧文件路径」错拉。新 files ready 后 selected 切到新文件再拉。
    if (loadedKey !== viewKey) return;
    if (!selected) {
      setContent(null);
      return;
    }
    let cancelled = false;
    setContentLoading(true);
    setContent(null);
    setContentError(null);
    const basePath = selected.oldPath ?? selected.path;
    const headPath = selected.path;
    Promise.all([
      invoke('diff:getFileContent', {
        localId: pr.localId,
        side: 'base',
        path: basePath,
        ...(range ?? {}),
      }),
      invoke('diff:getFileContent', {
        localId: pr.localId,
        side: 'head',
        path: headPath,
        ...(range ?? {}),
      }),
    ])
      .then(([base, head]) => {
        if (!cancelled) setContent({ base, head });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          console.warn('diff:getFileContent failed', e);
          setContentError(formatBackendError(e));
        }
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, pr.localId, loadedKey, viewKey, range]);

  return { content, contentLoading, contentError, setContentError };
}
