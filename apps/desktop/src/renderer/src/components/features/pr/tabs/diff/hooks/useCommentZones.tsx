import { useEffect } from 'react';
import { editor as MonacoEditorNs, type editor as MonacoEditor } from 'monaco-editor';
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
  /** 评论 emoji 反应模式（capabilities.commentReactions）：'fixed'/'free' 才渲染加反应按钮；缺省 = 不支持。 */
  reactionsMode?: 'fixed' | 'free';
  /** 平台是否支持图片附件上传（capabilities.commentAttachments）；透传给行内回复编辑框启用粘贴上传。 */
  attachmentsEnabled?: boolean;
  /** 内容只读（decline / 不可参与归档 PR）：行内评论 zone 隐藏回复 / 编辑 / 删除。 */
  readOnly?: boolean;
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
    reactionsMode,
    attachmentsEnabled = false,
    readOnly = false,
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
          // 评论锚点行在滚动条总览标尺投一个蓝色刻度（与评论 glyph 同色系），
          // 用户拖滚动条一眼可见「哪里有评论」；minimap 仍关闭。
          overviewRuler: {
            color: '#3794ff',
            position: MonacoEditorNs.OverviewRulerLane.Right,
          },
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
          reactionsMode={reactionsMode}
          attachmentsEnabled={attachmentsEnabled}
          readOnly={readOnly}
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
    reactionsMode,
    attachmentsEnabled,
    readOnly,
  ]);
}
