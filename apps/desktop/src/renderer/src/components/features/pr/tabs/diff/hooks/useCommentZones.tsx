import { useEffect } from 'react';
import { editor as MonacoEditorNs, type editor as MonacoEditor } from 'monaco-editor';
import type { PlatformKind, PlatformUser, PrComment } from '@meebox/shared';
import type { DiffChangedFile } from '@meebox/ipc';
import {
  CommentZone,
  estimateZoneHeight,
  renderHoverMd,
} from '../inline-comments/InlineCommentZone';
import { mountInlineZones } from '../zones/mountInlineZones';
import type { LoadedContent } from '../diff-types';

/**
 * Inline comment markers: a blue dot in the glyph margin on the comment's anchored line (hover shows a
 * markdown summary) + a view zone inserted below the line rendering the comment content. Zone mount /
 * cleanup goes through the shared mountInlineZones; glyph decorations are managed by this hook itself.
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
  /** Comment emoji reaction mode (capabilities.commentReactions): only 'fixed'/'free' render the add-reaction button; absent = unsupported. */
  reactionsMode?: 'fixed' | 'free';
  /** Whether the platform supports image attachment upload (capabilities.commentAttachments); passed through to the inline reply editor to enable paste upload. */
  attachmentsEnabled?: boolean;
  /** `@mention` autocomplete candidates for the inline reply editor (bounded PR participants; see collectMentionCandidates). Kept identical to the comments/activity tab so inline and page behave the same. */
  mentionCandidates?: PlatformUser[];
  /** Active platform, deciding inserted mention syntax (Bitbucket quotes non-simple usernames); passed through to the inline reply editor. */
  platform?: PlatformKind;
  /** Whether the platform supports remote user search (capabilities.userSearch); passed through to the inline reply editor for the mention remote fallback. */
  userSearchEnabled?: boolean;
  /** Content read-only (declined / non-participatable archived PR): inline comment zones hide reply / edit / delete. */
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
    mentionCandidates,
    platform,
    userSearchEnabled = false,
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
          // The comment anchor line projects a blue tick on the scrollbar overview ruler (same color family as
          // the comment glyph), so users see "where the comments are" at a glance when dragging; minimap stays off.
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
      // Don't intercept wheel — comment zones auto-size with no inner scroll, so the wheel must bubble to Monaco to
      // scroll the editor, otherwise the whole diff can't scroll while hovering a comment (stopPropagation would eat the scroll).
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
          mentionCandidates={mentionCandidates}
          platform={platform}
          userSearchEnabled={userSearchEnabled}
          readOnly={readOnly}
        />
      ),
    });

    return () => {
      try {
        originalDecorations.clear();
        modifiedDecorations.clear();
      } catch {
        // editor already disposed
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
    mentionCandidates,
    platform,
    userSearchEnabled,
    readOnly,
  ]);
}
