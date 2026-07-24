import { useEffect, useRef } from 'react';
import { editor as MonacoEditorNs, type editor as MonacoEditor } from 'monaco-editor';
import type { PlatformKind, PlatformUser, PrComment } from '@meebox/shared';
import type { DiffChangedFile } from '@meebox/ipc';
import {
  CommentZone,
  estimateZoneHeight,
  renderHoverMd,
} from '../inline-comments/InlineCommentZone';
import { createInlineZones, type InlineZonesController } from '../zones/mountInlineZones';
import { remapOldByLineToModified } from '../zones/line-mapping';
import type { LoadedContent } from '../diff-types';

/**
 * Inline comment markers: a blue dot in the glyph margin on the comment's anchored line (hover shows a
 * markdown summary) + a view zone inserted below the line rendering the comment content.
 *
 * Split into two effects deliberately. A **structural** effect owns the zone controller's lifecycle (recreated only
 * when the editor / file / view orientation changes); a **content** effect calls `controller.update(...)` whenever
 * the comments or passthrough props change, which **reconciles** zones in place rather than tearing them down. This
 * is what lets an in-progress inline reply / edit survive a comments refresh (e.g. the poller pulling a new remote
 * comment mid-typing): the anchored line's zone keeps its React root, so the open editor's text isn't discarded.
 * Glyph decorations are stateless and simply recreated by the content effect.
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

  // Structural lifecycle: (re)create the zone controller only when the editor / file / view orientation changes.
  // A comments refresh does NOT touch these deps, so the controller (and its live zones) survives — the content
  // effect below then reconciles into it instead of tearing everything down.
  const controllerRef = useRef<InlineZonesController<PrComment> | null>(null);
  useEffect(() => {
    if (!diffEditor || !content || !selected) return;
    const controller = createInlineZones<PrComment>({
      diffEditor,
      renderSideBySide,
      zoneClassName: 'monaco-comment-zone',
      innerClassName: 'monaco-comment-zone-inner',
      // Don't intercept wheel — comment zones auto-size with no inner scroll, so the wheel must bubble to Monaco to
      // scroll the editor, otherwise the whole diff can't scroll while hovering a comment (stopPropagation would eat the scroll).
      stopEvents: ['mousedown', 'mouseup', 'click', 'dblclick'],
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [diffEditor, content, selected, renderSideBySide]);

  // Content sync: reconcile zones + rebuild glyph decorations whenever comments / passthrough props change. Declared
  // after the structural effect so on mount the controller exists before this runs (React runs setup in order).
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || !diffEditor || !content || !selected) return;
    const fileComments = comments.filter(
      (c) =>
        c.anchor &&
        // File-level comments (no line) are not line-anchored; they render in DiffView's file-level strip, not here.
        c.anchor.line != null &&
        (c.anchor.path === selected.path ||
          (selected.oldPath && c.anchor.path === selected.oldPath)),
    );

    const oldByLine = new Map<number, PrComment[]>();
    const newByLine = new Map<number, PrComment[]>();
    for (const c of fileComments) {
      // fileComments already excludes line-less (file-level) anchors, so line is present here.
      const line = c.anchor!.line!;
      const target = c.anchor!.side === 'old' ? oldByLine : newByLine;
      const arr = target.get(line) ?? [];
      arr.push(c);
      target.set(line, arr);
    }

    // Reconcile the zones: unchanged anchored lines re-render in place (an open reply/edit editor keeps its text),
    // only genuinely added/removed lines mount/unmount.
    controller.update({
      oldByLine,
      newByLine,
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

    // Glyph-margin dots + overview-ruler ticks are stateless → just recreate them to match the current comments.
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
    // Old-side markers: in side-by-side they sit on the (visible) original editor; in unified — including
    // auto-degraded-from-side-by-side, since renderSideBySide here is the ACTUAL render mode — the original editor is
    // hidden, so remap them onto the modified editor at the mapped line (mirroring how the zone bodies are routed in
    // computeDesired), otherwise the glyph dot + overview tick vanish with the hidden editor.
    const modifiedLines = new Map(newByLine);
    let originalLines: Map<number, PrComment[]> | null = oldByLine;
    if (!renderSideBySide && oldByLine.size > 0) {
      originalLines = null;
      const remappedOld = remapOldByLineToModified(diffEditor.getLineChanges() ?? [], oldByLine);
      for (const [line, cs] of remappedOld) {
        modifiedLines.set(line, [...(modifiedLines.get(line) ?? []), ...cs]);
      }
    }
    const originalDecorations = originalLines
      ? originalEditor.createDecorationsCollection(buildDecorations(originalLines))
      : null;
    const modifiedDecorations = modifiedEditor.createDecorationsCollection(
      buildDecorations(modifiedLines),
    );

    return () => {
      try {
        originalDecorations?.clear();
        modifiedDecorations.clear();
      } catch {
        // editor already disposed
      }
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
