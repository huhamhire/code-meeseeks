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
 * blame 数据 + Monaco 视图坐标同步。仅在开关开 + 文件有 head 内容时拉；deleted / 二进制不拉。
 * blameLayout 从 Monaco modified editor 同步 lineHeight / scrollTop / viewportHeight，供独立
 * React blame 列定位（见 BlameColumn）。
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
  // Monaco modified editor 的视图坐标 (用于 React overlay 渲染 blame 列)；
  // null = blame 关 / blame 数据没好 / editor 未挂载
  const [blameLayout, setBlameLayout] = useState<BlameLayout | null>(null);

  // 拉 blame：仅在开关开 + 文件有 head 内容时跑。deleted 文件 / 二进制不跑。
  useEffect(() => {
    // 门控：切视图期间不拉 blame（同 content：避免新视图 + 旧文件错拉），保留旧 blame。
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

  // Blame 走独立 React 列（Bitbucket 风格），不在 Monaco DOM 里。只需要从 Monaco
  // 同步 lineHeight / scrollTop / viewportHeight，BlameColumn 自己用 absolute
  // 子项画 row 并按 scrollTop 平移。
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
    // 初次 mount 时 layout 可能还在计算，下一 tick 再算一次
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
