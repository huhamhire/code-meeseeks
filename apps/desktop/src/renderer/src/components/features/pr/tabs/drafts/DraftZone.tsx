import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type { PlatformKind, PlatformUser, ReviewDraft } from '@meebox/shared';
import { ConfirmModal, TrashIcon } from '../../../../common';
import { MentionTextarea } from '../shared/MentionTextarea';
import { uploadCommentImage } from '../shared/uploadCommentImage';
import { useDraftZone } from './useDraftZone';

interface DraftZoneProps {
  draft: ReviewDraft;
  /** localId of the owning PR; the draft editor's image upload (when attachmentsEnabled) uses it to locate the PR attachment store. */
  prLocalId: string;
  /** Whether the platform supports image attachment upload (capabilities.commentAttachments); only when true does the draft editor enable paste / pick upload. */
  attachmentsEnabled?: boolean;
  /** Comment line-break policy (active platform commentHardBreaks): decides whether the preview enables remark-breaks, making the draft preview WYSIWYG. */
  hardBreaks: boolean;
  /** `@mention` autocomplete candidates for the editor (bounded PR participants; see collectMentionCandidates). Empty/undefined = no completion menu, but manual `@name` still works. */
  mentionCandidates?: PlatformUser[];
  /** Active platform, deciding inserted mention syntax (Bitbucket quotes non-simple usernames). */
  platform?: PlatformKind;
  /**
   * Register the "enter edit mode" trigger fn into an external ref map. When DiffView calls the
   * registered fn, this component setIsEditing(true). Uses a ref-based fn instead of a props token to
   * avoid unmount/mount cycle mis-triggers caused by trigger token changes (see useDraftZone).
   */
  registerEditTrigger?: (draftId: string, fn: (() => void) | null) => void;
  /** Save the edited body. Caller goes through IPC drafts:update. */
  onSave: (newBody: string) => void | Promise<void>;
  /** Delete this draft. Caller goes through IPC drafts:delete */
  onDelete: () => void | Promise<void>;
  /**
   * Publish a single draft directly to remote. Caller goes through drafts:publishBatch with a single-element draftIds.
   * On ok=false, error carries a human-readable cause; this component renders an inline error but does not unmount the zone.
   * Absent = read mode, does not render the "publish" button.
   */
  onPublish?: () => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Inline draft editing zone inside the Diff view. Mounted in Monaco editor's view zone, rendered via
 * `createRoot.render(<DraftZone ... />)`. read/edit/publish state machine see [useDraftZone](./useDraftZone.ts);
 * this component only handles rendering.
 *
 * Visually distinguished from CommentZone (remote comment, read-only): CommentZone yellow bg → here **blue bg + DRAFT chip**;
 * posted switches to green bg to align with remote comments; rejected is hidden by default via css (DiffView side .monaco-draft-zone-rejected).
 */
export function DraftZone({
  draft,
  prLocalId,
  attachmentsEnabled = false,
  hardBreaks,
  mentionCandidates,
  platform,
  registerEditTrigger,
  onSave,
  onDelete,
  onPublish,
}: DraftZoneProps) {
  const { t } = useTranslation();
  const {
    status,
    canEdit,
    canSave,
    isStash,
    cancelLabel,
    isEditing,
    setIsEditing,
    editingBody,
    setEditingBody,
    saving,
    publishing,
    publishError,
    setPublishError,
    confirmDelete,
    setConfirmDelete,
    textareaRef,
    handleSave,
    handlePublish,
    handlePublishFromEdit,
    handleCancel,
    handleDelete,
    handleConfirmDelete,
    onKeyDown,
  } = useDraftZone({ draft, registerEditTrigger, onSave, onDelete, onPublish });

  const statusLabel: Record<typeof status, string> = {
    pending: t('draftZone.statusPending'),
    edited: t('draftZone.statusEdited'),
    posted: t('draftZone.statusPosted'),
    rejected: t('draftZone.statusRejected'),
  };

  return (
    <div className={`draft-zone-inner draft-zone-status-${status}`}>
      <div className="draft-zone-head">
        <span className="draft-zone-tag">{t('draftZone.tag')}</span>
        <span className={`draft-zone-status draft-zone-status-chip-${status}`}>
          {statusLabel[status]}
        </span>
        <span className="draft-zone-origin muted">
          {draft.origin === 'finding' ? t('draftZone.originFinding') : t('draftZone.originMine')}
        </span>
        {!isEditing && canEdit && (
          <div className="draft-zone-actions">
            {/* Single "publish": shown only for pending/edited (posted is already published so no button;
                rejected state has its whole zone hidden by CSS on DiffView side, never reaches here).
                While publishing the button is disabled, label changes to "publishing…"; other buttons also disable to avoid
                concurrent save / delete / publish on the same draft */}
            {onPublish && (
              <button
                type="button"
                className="draft-zone-btn draft-zone-btn-primary"
                onClick={() => void handlePublish()}
                disabled={publishing || !draft.body.trim()}
                title={
                  !draft.body.trim()
                    ? t('draftZone.publishEmptyTitle')
                    : t('draftZone.publishOneTitle')
                }
              >
                {publishing ? t('draftZone.publishing') : t('draftZone.publish')}
              </button>
            )}
            <button
              type="button"
              className="draft-zone-btn"
              onClick={() => {
                setEditingBody(draft.body);
                setIsEditing(true);
              }}
              disabled={publishing}
              title={t('draftZone.editTitle')}
            >
              {t('common.edit')}
            </button>
            <button
              type="button"
              className="draft-zone-btn draft-zone-btn-icon draft-zone-btn-danger"
              onClick={() => void handleDelete()}
              disabled={publishing}
              title={t('draftZone.deleteTitle')}
              aria-label={t('draftZone.deleteAria')}
            >
              <TrashIcon />
            </button>
          </div>
        )}
      </div>
      {isEditing ? (
        <div className="draft-zone-edit">
          <MentionTextarea
            className="draft-zone-textarea"
            value={editingBody}
            onChange={setEditingBody}
            candidates={mentionCandidates ?? []}
            platform={platform}
            onKeyDown={onKeyDown}
            onUpload={
              attachmentsEnabled ? (f) => uploadCommentImage(prLocalId, f) : undefined
            }
            placeholder={t('draftZone.textareaPlaceholder')}
            rows={4}
            disabled={saving || publishing}
            ariaLabel={t('draftZone.textareaAria')}
            textareaRef={textareaRef}
          />
          <div className="draft-zone-edit-actions">
            {/* Primary button: "publish" when onPublish is present (auto-save first, then POST, aligned with cancel's
                auto-save behavior to avoid redundant dual buttons); falls back to "save" when onPublish is absent */}
            {onPublish ? (
              <button
                type="button"
                className="draft-zone-btn draft-zone-btn-primary"
                onClick={() => void handlePublishFromEdit()}
                disabled={saving || publishing || !canSave}
                title={
                  !canSave ? t('draftZone.emptyCommentTitle') : t('draftZone.publishFromEditTitle')
                }
              >
                {publishing
                  ? t('draftZone.publishing')
                  : saving
                    ? t('draftZone.saving')
                    : t('draftZone.publish')}
              </button>
            ) : (
              <button
                type="button"
                className="draft-zone-btn draft-zone-btn-primary"
                onClick={() => void handleSave()}
                disabled={saving || !canSave}
                title={!canSave ? t('draftZone.emptyCommentTitle') : t('draftZone.saveTitle')}
              >
                {saving ? t('draftZone.saving') : t('common.save')}
              </button>
            )}
            <button
              type="button"
              className="draft-zone-btn"
              onClick={() => void handleCancel()}
              disabled={saving || publishing}
              title={isStash ? t('draftZone.stashTitle') : t('draftZone.cancelTitle')}
            >
              {cancelLabel}
            </button>
            {canEdit && (
              <button
                type="button"
                className="draft-zone-btn draft-zone-btn-icon draft-zone-btn-danger draft-zone-edit-delete"
                onClick={() => void handleDelete()}
                disabled={saving || publishing}
                title={t('draftZone.deleteEditTitle')}
                aria-label={t('draftZone.deleteAria')}
              >
                <TrashIcon />
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="draft-zone-body markdown">
          {draft.body.trim() ? (
            <ReactMarkdown remarkPlugins={hardBreaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}>
              {draft.body}
            </ReactMarkdown>
          ) : (
            <span className="muted">{t('draftZone.emptyDraftHint')}</span>
          )}
        </div>
      )}
      {draft.posted_remote_id && (
        <div className="draft-zone-foot muted">
          {t('draftZone.postedRemoteId', { id: draft.posted_remote_id })}
        </div>
      )}
      {publishError && (
        <div className="draft-zone-publish-error" role="alert">
          {t('draftZone.publishErrorPrefix', { error: publishError })}
          <button
            type="button"
            className="draft-zone-publish-error-dismiss"
            onClick={() => setPublishError(null)}
            aria-label={t('draftZone.dismissErrorAria')}
            title={t('draftZone.gotIt')}
          >
            ✕
          </button>
        </div>
      )}
      {confirmDelete && (
        <ConfirmModal
          title={t('draftZone.deleteConfirmTitle')}
          message={t('draftZone.deleteConfirmMessage')}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          danger
          onConfirm={() => void handleConfirmDelete()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}
