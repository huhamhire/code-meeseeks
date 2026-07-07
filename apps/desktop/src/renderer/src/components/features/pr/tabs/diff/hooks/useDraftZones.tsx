import { useEffect } from 'react';
import { type editor as MonacoEditor } from 'monaco-editor';
import type { PlatformKind, PlatformUser, ReviewDraft } from '@meebox/shared';
import type { DiffChangedFile } from '@meebox/ipc';
import { DraftZoneList } from '../DraftZoneList';
import { mountInlineZones } from '../zones/mountInlineZones';
import type { LoadedContent } from '../diff-types';

/**
 * Inline draft view zones (blue background, editable). Uses the same mountInlineZones mechanism as comment zones, bucketed by anchor.side,
 * with endLine as the zone line number (aligned with the publish anchor, WYSIWYG).
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

  useEffect(() => {
    if (!diffEditor || !content || !selected) return;
    // commit read-only view: does not render local draft zones (drafts are anchored on the PR full-diff line numbers, not applicable to a single commit).
    if (scopeKind !== 'all') return;
    const fileDrafts = (drafts ?? []).filter((d) => {
      if (d.status === 'rejected' || d.status === 'posted') return false;
      return d.anchor.path === selected.path || selected.oldPath === d.anchor.path;
    });
    if (fileDrafts.length === 0) return;

    const oldByLine = new Map<number, ReviewDraft[]>();
    const newByLine = new Map<number, ReviewDraft[]>();
    for (const d of fileDrafts) {
      const target = d.anchor.side === 'old' ? oldByLine : newByLine;
      // Use endLine as the zone line number, aligned with the publish anchor — publishInlineComment sends to
      // the remote using anchor.endLine, and the draft zone also lands on endLine, so "preview position = final publish position" (WYSIWYG). nav reveal highlights the same
      // endLine, so the two are visually consistent, and a multi-line finding (startLine=403, endLine=425) won't have its start/end misplaced.
      const arr = target.get(d.anchor.endLine) ?? [];
      arr.push(d);
      target.set(d.anchor.endLine, arr);
    }

    return mountInlineZones<ReviewDraft>({
      diffEditor,
      renderSideBySide,
      oldByLine,
      newByLine,
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
    // Does not depend on zone rebuilds triggered by autoEditTokens / registerEditTrigger (registerEditTrigger is a stable
    // useCallback) — avoids trigger-induced DraftZone unmount/mount, eliminating the race of re-entering edit mode after cancel.
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
