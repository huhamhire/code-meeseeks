import { useEffect, useState } from 'react';
import type { StoredPullRequest } from '@meebox/shared';
import type { DiffChangedFile } from '@meebox/ipc';
import { invoke } from '../../../../../../api';
import { formatBackendError, type FormattedError } from '../../../../../../errors';
import { fileKey } from '../diff-types';

export interface ChangedFilesState {
  files: DiffChangedFile[] | null;
  filesError: FormattedError | null;
  retryFiles: () => void;
  selectedKey: string | null;
  setSelectedKey: React.Dispatch<React.SetStateAction<string | null>>;
  selected: DiffChangedFile | null;
  /** Rendered view identifier: only advances to the current viewKey once new files land; before that each effect is gated and the old view is kept alive. */
  loadedKey: string | null;
}

/**
 * Fetch changed files list + selected file management. Keeps rendering old files while switching PR / scope (stale-while-loading),
 * only advancing loadedKey to viewKey and replacing wholesale once new files land.
 */
export function useChangedFiles(
  pr: StoredPullRequest,
  range: { base: string; head: string } | null,
  viewKey: string,
): ChangedFilesState {
  const [files, setFiles] = useState<DiffChangedFile[] | null>(null);
  const [filesError, setFilesError] = useState<FormattedError | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filesRetry, setFilesRetry] = useState(0);

  // Fetch changed files list (fatal failure → fallback for the entire diff area)
  useEffect(() => {
    let cancelled = false;
    setFilesError(null);
    invoke('diff:listChangedFiles', { localId: pr.localId, ...(range ?? {}) })
      .then((f) => {
        if (cancelled) return;
        setFiles(f);
        // Only advance the "rendered view" to the current viewKey once new files land — before that each effect is gated and the old view is kept alive.
        setLoadedKey(viewKey);
        // Selection: keep it if still present (same-view retry / same-named file still there after scope switch keeps selection), otherwise fall back to the first.
        setSelectedKey((prev) =>
          prev && f.some((x) => fileKey(x) === prev) ? prev : f.length > 0 ? fileKey(f[0]!) : null,
        );
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const fmt = formatBackendError(e);
          console.warn('diff:listChangedFiles failed', e);
          setFilesError(fmt);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pr.localId, filesRetry, range, viewKey]);

  const selected = files?.find((f) => fileKey(f) === selectedKey) ?? null;

  return {
    files,
    filesError,
    retryFiles: () => setFilesRetry((n) => n + 1),
    selectedKey,
    setSelectedKey,
    selected,
    loadedKey,
  };
}
