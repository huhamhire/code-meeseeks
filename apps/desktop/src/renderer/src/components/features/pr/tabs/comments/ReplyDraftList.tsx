import type { PlatformKind, PlatformUser } from '@meebox/shared';
import { invoke } from '../../../../../api';
import { formatBackendError } from '../../../../../errors';
import { useDraftsForPr } from '../../../../../stores/drafts-store';
import { DraftZone } from '../drafts/DraftZone';

/**
 * Pending reply-drafts for one parent comment, rendered below it as editable draft cards (reusing {@link DraftZone}).
 * Shared by every comment surface — the activity timeline's `CommentItem` and the inline diff `CommentNode` — so a
 * reply behaves the same everywhere: it is a deferred draft (persisted, survives switching) that publishes via the
 * reply API in the "Publish comments" batch, mirroring how a new inline comment is a draft.
 *
 * Reads the shared drafts store and filters to this parent's reply-drafts; `rejected` / `posted` are not shown
 * (rejected = the user dropped it; posted = the remote reply already took over and is fetched as a normal comment).
 */
export function ReplyDraftList({
  prLocalId,
  parentCommentId,
  hardBreaks,
  mentionCandidates,
  platform,
  attachmentsEnabled = false,
  userSearchEnabled = false,
  readOnly = false,
}: {
  prLocalId: string;
  /** Reply target id — the same value used as the reply's parent (comment.threadId ?? comment.remoteId). */
  parentCommentId: string;
  hardBreaks: boolean;
  mentionCandidates?: PlatformUser[];
  platform?: PlatformKind;
  attachmentsEnabled?: boolean;
  userSearchEnabled?: boolean;
  /** Content read-only (declined / non-participable archived PR): don't render draft editors. */
  readOnly?: boolean;
}) {
  const drafts = useDraftsForPr(prLocalId);
  if (readOnly) return null;
  const replyDrafts = (drafts ?? []).filter(
    (d) =>
      d.kind === 'reply' &&
      d.replyTo?.parentCommentId === parentCommentId &&
      d.status !== 'rejected' &&
      d.status !== 'posted',
  );
  if (replyDrafts.length === 0) return null;

  const onSave = async (draftId: string, body: string): Promise<void> => {
    await invoke('drafts:update', { localId: prLocalId, draftId, patch: { body } });
  };
  const onDelete = async (draftId: string): Promise<void> => {
    await invoke('drafts:delete', { localId: prLocalId, draftId });
  };
  // Single publish reuses drafts:publishBatch with one id (same main-side path as the batch modal / DraftZoneList),
  // so the reply-publish branch stays the single source of truth.
  const onPublish = async (draftId: string): Promise<{ ok: boolean; error?: string }> => {
    const resp = await invoke('drafts:publishBatch', { localId: prLocalId, draftIds: [draftId] });
    const r = resp.results[0];
    if (!r) return { ok: false, error: 'no result' };
    return { ok: r.ok, error: r.error ? formatBackendError(r.error).title : undefined };
  };

  return (
    <div className="reply-draft-list">
      {replyDrafts.map((d) => (
        <DraftZone
          key={d.id}
          draft={d}
          prLocalId={prLocalId}
          attachmentsEnabled={attachmentsEnabled}
          hardBreaks={hardBreaks}
          mentionCandidates={mentionCandidates}
          platform={platform}
          userSearchEnabled={userSearchEnabled}
          onSave={(body) => onSave(d.id, body)}
          onDelete={() => onDelete(d.id)}
          onPublish={() => onPublish(d.id)}
        />
      ))}
    </div>
  );
}
