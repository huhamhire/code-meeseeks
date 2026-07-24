import { useEffect, useRef } from 'react';
import { type editor as MonacoEditor } from 'monaco-editor';
import type { PlatformKind, PlatformUser, ReviewDraft } from '@meebox/shared';
import type { DiffChangedFile } from '@meebox/ipc';
import { DraftZoneList } from '../DraftZoneList';
import { createInlineZones, type InlineZonesController } from '../zones/mountInlineZones';
import type { LoadedContent } from '../diff-types';

/**
 * Inline draft view zones (blue background, editable). Uses the same zone mechanism as comment zones, bucketed by
 * anchor.side, with endLine as the zone line number (aligned with the publish anchor, WYSIWYG).
 *
 * Split into two effects like {@link useCommentZones}: a **structural** effect owns the zone controller's lifecycle
 * (recreated only when the editor / file / view orientation / scope changes); a **content** effect calls
 * `controller.update(...)` whenever the drafts or passthrough props change, which **reconciles** zones by (side, line)
 * key rather than tearing them down. This lets an in-progress inline draft edit survive a drafts/comments refresh
 * (e.g. the poller pulling a new remote comment mid-typing, or another draft being added elsewhere): the anchored
 * line's zone keeps its React root, so the open editor's text / focus / caret aren't discarded. A genuinely removed
 * draft (deleted / published / anchor moved / file switch) still unmounts, firing its useDraftZone cancel cleanup.
 *
 * Does not render rejected (user decided not to send) / posted (the remote comment is already taken over by CommentZone; re-rendering would be visually duplicate).
 * The commit read-only view (scopeKind !== 'all') does not render drafts (anchored on the PR full-diff line numbers, not applicable to a single commit).
 */
export function useDraftZones(opts: {
  diffEditor: MonacoEditor.IStandaloneDiffEditor | null;
  drafts: readonly ReviewDraft[] | null;
  content: LoadedContent | null;
  selected: DiffChangedFile | null;
  prLocalId: string;
  registerEditTrigger: (draftId: string, fn: (() => void) | null) => void;
  renderSideBySide: boolean;
  commentHardBreaks: boolean;
  /** Whether the platform supports image attachment upload (capabilities.commentAttachments); passed through to the draft editor to enable paste / picker upload. */
  attachmentsEnabled?: boolean;
  /** `@mention` autocomplete candidates for the draft editor (bounded PR participants; see collectMentionCandidates). */
  mentionCandidates?: PlatformUser[];
  /** Active platform, deciding inserted mention syntax (Bitbucket quotes non-simple usernames). */
  platform?: PlatformKind;
  /** Whether the platform supports remote user search (capabilities.userSearch); passed through to the draft editor for the mention remote fallback. */
  userSearchEnabled?: boolean;
  scopeKind: 'all' | 'commit';
}): void {
  const {
    diffEditor,
    drafts,
    content,
    selected,
    prLocalId,
    registerEditTrigger,
    renderSideBySide,
    commentHardBreaks,
    attachmentsEnabled = false,
    mentionCandidates,
    platform,
    userSearchEnabled = false,
    scopeKind,
  } = opts;

  // Structural lifecycle: (re)create the zone controller only when the editor / file / view orientation / scope
  // changes. A drafts or comments refresh does NOT touch these deps, so the controller (and its live zones) survives —
  // the content effect below then reconciles into it instead of tearing everything down.
  const controllerRef = useRef<InlineZonesController<ReviewDraft> | null>(null);
  useEffect(() => {
    if (!diffEditor || !content || !selected) return;
    // commit read-only view: does not render local draft zones (drafts are anchored on the PR full-diff line numbers, not applicable to a single commit).
    if (scopeKind !== 'all') return;
    const controller = createInlineZones<ReviewDraft>({
      diffEditor,
      renderSideBySide,
      zoneClassName: 'monaco-draft-zone',
      innerClassName: 'monaco-draft-zone-inner',
      stopEvents: [
        'mousedown',
        'mouseup',
        'click',
        'dblclick',
        'keydown',
        'keyup',
        'wheel',
        'contextmenu',
      ],
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [diffEditor, content, selected, renderSideBySide, scopeKind]);

  // Content sync: reconcile draft zones whenever the drafts / passthrough props change. Declared after the structural
  // effect so on mount the controller exists before this runs (React runs setup in order). Reconcile means a surviving
  // draft re-renders in place (an open editor keeps its text / focus), only added/removed drafts mount/unmount.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || !diffEditor || !content || !selected) return;
    if (scopeKind !== 'all') return;
    const fileDrafts = (drafts ?? []).filter((d) => {
      if (d.status === 'rejected' || d.status === 'posted') return false;
      // Reply-drafts render nested under their parent comment (ReplyDraftList), not as standalone line zones — skip them here.
      if (d.kind === 'reply') return false;
      if (!d.anchor) return false;
      return d.anchor.path === selected.path || selected.oldPath === d.anchor.path;
    });

    const oldByLine = new Map<number, ReviewDraft[]>();
    const newByLine = new Map<number, ReviewDraft[]>();
    for (const d of fileDrafts) {
      // fileDrafts filter guarantees a non-reply draft with an anchor.
      const anchor = d.anchor!;
      const target = anchor.side === 'old' ? oldByLine : newByLine;
      // Use endLine as the zone line number, aligned with the publish anchor — publishInlineComment sends to
      // the remote using anchor.endLine, and the draft zone also lands on endLine, so "preview position = final publish position" (WYSIWYG). nav reveal highlights the same
      // endLine, so the two are visually consistent, and a multi-line finding (startLine=403, endLine=425) won't have its start/end misplaced.
      const arr = target.get(anchor.endLine) ?? [];
      arr.push(d);
      target.set(anchor.endLine, arr);
    }

    // Reconcile: unchanged draft lines re-render in place (an open draft editor keeps its text / focus / caret), only
    // genuinely added/removed lines mount/unmount. An empty set removes all remaining zones (no early-return, so
    // deleting the last draft on a line tears its zone down through the controller).
    controller.update({
      oldByLine,
      newByLine,
      initialHeight: (ds) => Math.max(ds.length * 60, 80),
      render: (ds) => (
        <DraftZoneList
          drafts={ds}
          prLocalId={prLocalId}
          registerEditTrigger={registerEditTrigger}
          hardBreaks={commentHardBreaks}
          attachmentsEnabled={attachmentsEnabled}
          mentionCandidates={mentionCandidates}
          platform={platform}
          userSearchEnabled={userSearchEnabled}
        />
      ),
    });
  }, [
    diffEditor,
    drafts,
    content,
    selected,
    prLocalId,
    registerEditTrigger,
    renderSideBySide,
    commentHardBreaks,
    attachmentsEnabled,
    mentionCandidates,
    platform,
    userSearchEnabled,
    scopeKind,
  ]);
}
