import { useEffect, useState } from 'react';
import { editor as MonacoEditorNs, type editor as MonacoEditor } from 'monaco-editor';
import type { StoredPullRequest } from '@meebox/shared';
import type { DiffBlameLine, DiffChangedFile } from '@meebox/ipc';
import { invoke } from '../../../../../../api';
import { formatBackendError, type FormattedError } from '../../../../../../errors';
import type { BlameLayout } from '../blame/blame-utils';
import type { LoadedContent } from '../diff-types';

export interface BlameState {
  blame: { lines: DiffBlameLine[]; changedLines: number[] } | null;
  blameError: FormattedError | null;
  blameLayout: BlameLayout | null;
  setBlameError: (v: FormattedError | null) => void;
}

/**
 * blame data + Monaco view coordinate sync. Only fetched when the toggle is on + the file has head content; deleted / binary are not fetched.
 * blameLayout syncs lineHeight / scrollTop / viewportHeight from the Monaco modified editor, for positioning the independent
 * React blame column (see BlameColumn).
 */
export function useBlame(
  pr: StoredPullRequest,
  selected: DiffChangedFile | null,
  content: LoadedContent | null,
  showBlame: boolean,
  range: { base: string; head: string } | null,
  loadedKey: string | null,
  viewKey: string,
  diffEditor: MonacoEditor.IStandaloneDiffEditor | null,
): BlameState {
  const [blame, setBlame] = useState<{
    lines: DiffBlameLine[];
    changedLines: number[];
  } | null>(null);
  const [blameError, setBlameError] = useState<FormattedError | null>(null);
  // View coordinates of the Monaco modified editor (used by the React overlay to render the blame column);
  // null = blame off / blame data not ready / editor not mounted
  const [blameLayout, setBlameLayout] = useState<BlameLayout | null>(null);

  // Fetch blame: only runs when the toggle is on + the file has head content. deleted files / binary do not run.
  useEffect(() => {
    // Gate: don't fetch blame while switching views (same as content: avoids mis-fetching new view + old file), keep old blame.
    if (loadedKey !== viewKey) return;
    if (!showBlame || !selected || !content || content.head.binary) {
      setBlame(null);
      setBlameError(null);
      return;
    }
    if (selected.status === 'deleted') {
      setBlame(null);
      setBlameError(null);
      return;
    }
    let cancelled = false;
    setBlameError(null);
    invoke('diff:getBlame', { localId: pr.localId, path: selected.path, ...(range ?? {}) })
      .then((b) => {
        if (!cancelled) setBlame(b);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          console.warn('[blame:fetch] failed', e);
          setBlame(null);
          setBlameError(formatBackendError(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [showBlame, selected, content, pr.localId, loadedKey, viewKey, range]);

  // Blame uses an independent React column (Bitbucket-style), not inside the Monaco DOM. It only needs to
  // sync lineHeight / scrollTop / viewportHeight from Monaco; BlameColumn draws rows with its own absolute
  // children and shifts them by scrollTop.
  useEffect(() => {
    if (!diffEditor || !showBlame || !blame || blame.lines.length === 0) {
      setBlameLayout(null);
      return;
    }
    const modifiedEditor = diffEditor.getModifiedEditor();
    const update = (): void => {
      const dom = modifiedEditor.getDomNode();
      if (!dom) return;
      const layout = modifiedEditor.getLayoutInfo();
      const lh = modifiedEditor.getOption(MonacoEditorNs.EditorOption.lineHeight);
      setBlameLayout({
        viewportHeight: layout.height,
        lineHeight: typeof lh === 'number' && lh > 0 ? lh : 19,
        scrollTop: modifiedEditor.getScrollTop(),
      });
    };
    update();
    // On initial mount layout may still be computing, so recompute once on the next tick
    const t = setTimeout(update, 0);
    const subs = [
      modifiedEditor.onDidScrollChange(update),
      modifiedEditor.onDidLayoutChange(update),
    ];
    const ro = new ResizeObserver(update);
    const dom = modifiedEditor.getDomNode();
    if (dom) ro.observe(dom);
    return () => {
      clearTimeout(t);
      for (const s of subs) s.dispose();
      ro.disconnect();
    };
  }, [diffEditor, showBlame, blame]);

  return { blame, blameError, blameLayout, setBlameError };
}
