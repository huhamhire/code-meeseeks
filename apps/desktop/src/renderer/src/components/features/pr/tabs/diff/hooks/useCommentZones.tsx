import { useEffect } from 'react';
import { type editor as MonacoEditor } from 'monaco-editor';
import type { PrComment } from '@meebox/shared';
import type { DiffChangedFile } from '@meebox/ipc';
import {
  CommentZone,
  estimateZoneHeight,
  renderHoverMd,
} from '../inline-comments/InlineCommentZone';
import { mountInlineZones } from '../zones/mountInlineZones';
import type { LoadedContent } from '../diff-types';

/**
 * 行内评论标记：评论锚定行 glyph margin 蓝点（hover 出 markdown 摘要）+ 行下方插 view zone 渲染
 * 评论内容。zone 挂载 / 清理走通用 mountInlineZones；glyph decorations 由本 hook 自管。
 */
export function useCommentZones(opts: {
  diffEditor: MonacoEditor.IStandaloneDiffEditor | null;
  comments: PrComment[];
  content: LoadedContent | null;
  selected: DiffChangedFile | null;
  connectionId: string;
  attachmentBase: string | null;
  prLocalId: string;
  prWebUrl: string;
  renderSideBySide: boolean;
  commentHardBreaks: boolean;
}): void {
  const {
    diffEditor,
    comments,
    content,
    selected,
    connectionId,
    attachmentBase,
    prLocalId,
    prWebUrl,
    renderSideBySide,
    commentHardBreaks,
  } = opts;

  useEffect(() => {
    if (!diffEditor || !content || !selected) return;
    const fileComments = comments.filter(
      (c) =>
        c.anchor &&
        (c.anchor.path === selected.path ||
          (selected.oldPath && c.anchor.path === selected.oldPath)),
    );

    const oldByLine = new Map<number, PrComment[]>();
    const newByLine = new Map<number, PrComment[]>();
    for (const c of fileComments) {
      const target = c.anchor!.side === 'old' ? oldByLine : newByLine;
      const arr = target.get(c.anchor!.line) ?? [];
      arr.push(c);
      target.set(c.anchor!.line, arr);
    }

    const buildDecorations = (
      byLine: Map<number, PrComment[]>,
    ): MonacoEditor.IModelDeltaDecoration[] =>
      Array.from(byLine.entries()).map(([line, cs]) => ({
        range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
        options: {
          isWholeLine: true,
          glyphMarginClassName: 'monaco-comment-glyph',
          glyphMarginHoverMessage: { value: renderHoverMd(cs) },
          linesDecorationsClassName: 'monaco-comment-line-deco',
        },
      }));

    const originalEditor = diffEditor.getOriginalEditor();
    const modifiedEditor = diffEditor.getModifiedEditor();
    const originalDecorations = originalEditor.createDecorationsCollection(
      buildDecorations(oldByLine),
    );
    const modifiedDecorations = modifiedEditor.createDecorationsCollection(
      buildDecorations(newByLine),
    );

    const cleanupZones = mountInlineZones<PrComment>({
      diffEditor,
      renderSideBySide,
      oldByLine,
      newByLine,
      zoneClassName: 'monaco-comment-zone',
      innerClassName: 'monaco-comment-zone-inner',
      // 不拦 wheel —— 评论区 auto-size 无内部滚动，滚轮要冒泡给 Monaco 滚编辑器，
      // 否则鼠标停在评论上时整个 diff 无法滚动（stopPropagation 会吃掉滚动）。
      stopEvents: ['mousedown', 'mouseup', 'click', 'dblclick'],
      initialHeight: (cs, lineHeight) =>
        Math.max(estimateZoneHeight(cs) * lineHeight, lineHeight * 3),
      render: (cs) => (
        <CommentZone
          comments={cs}
          connectionId={connectionId}
          attachmentBase={attachmentBase}
          prLocalId={prLocalId}
          prWebUrl={prWebUrl}
          hardBreaks={commentHardBreaks}
        />
      ),
    });

    return () => {
      try {
        originalDecorations.clear();
        modifiedDecorations.clear();
      } catch {
        // editor 已 dispose
      }
      cleanupZones();
    };
  }, [
    diffEditor,
    comments,
    content,
    selected,
    connectionId,
    attachmentBase,
    prLocalId,
    prWebUrl,
    renderSideBySide,
    commentHardBreaks,
  ]);
}
