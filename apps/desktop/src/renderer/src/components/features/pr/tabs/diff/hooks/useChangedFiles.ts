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
  /** 已渲染视图标识：新 files 到位才推进到当前 viewKey，在此之前各 effect 门控、旧视图保活。 */
  loadedKey: string | null;
}

/**
 * 拉变更文件列表 + 选中文件管理。切 PR / 切范围期间保留旧 files 渲染（stale-while-loading），
 * 新 files 到位才把 loadedKey 推进到 viewKey、整体替换。
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

  // 拉变更文件列表 (fatal 失败 → 整个 diff 区域 fallback)
  useEffect(() => {
    let cancelled = false;
    setFilesError(null);
    invoke('diff:listChangedFiles', { localId: pr.localId, ...(range ?? {}) })
      .then((f) => {
        if (cancelled) return;
        setFiles(f);
        // 新 files 到位才把「已渲染视图」推进到当前 viewKey —— 在此之前各 effect 门控、旧视图保活。
        setLoadedKey(viewKey);
        // 选中项：仍存在则保留（同视图重试 / 切范围后同名文件仍在则不丢选中），否则回落首个。
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
