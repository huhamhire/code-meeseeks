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

/** Reads the base / head content of the selected file. During a view switch it is gated (loadedKey !== viewKey), keeping the old content. */
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
    // Gate: during a view switch (new files not yet arrived, selected still points to the old file), do not fetch content, keep rendering the old content,
    // avoiding a wrong fetch with "new view + old file path". After the new files are ready and selected switches to the new file, fetch then.
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
