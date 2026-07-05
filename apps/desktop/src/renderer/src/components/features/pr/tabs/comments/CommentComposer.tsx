import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlatformUser } from '@meebox/shared';
import { invoke } from '../../../../../api';
import { MentionTextarea } from '../shared/MentionTextarea';
import { uploadCommentImage } from '../shared/uploadCommentImage';

interface CommentComposerProps {
  prLocalId: string;
  /** `@mention` autocomplete candidates (PR participants + comment authors, derived by the parent from loaded data). */
  mentionCandidates?: PlatformUser[];
  /** Whether the platform supports image attachment upload (capabilities.commentAttachments); paste-to-upload is enabled only when true. */
  attachmentsEnabled?: boolean;
  onCancel: () => void;
  /** Called after posting succeeds (collapses the composer; the timeline auto-refreshes via the comments:changed event, the new comment appears at the top) */
  onPosted: () => void;
}

/**
 * Composer for a new summary (not anchored to a file) comment: textarea + send/cancel. Appears at the top of the activity timeline.
 * Cmd/Ctrl+Enter sends, Esc cancels; send is disabled on an empty body. Layout reuses the reply composer's styles.
 */
export function CommentComposer({
  prLocalId,
  mentionCandidates = [],
  attachmentsEnabled = false,
  onCancel,
  onPosted,
}: CommentComposerProps) {
  const { t } = useTranslation();
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = body.trim().length > 0 && !posting;

  const handleSave = async (): Promise<void> => {
    if (!canSave) return;
    setPosting(true);
    setError(null);
    try {
      await invoke('comments:create', { localId: prLocalId, body });
      onPosted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="comment-reply-editor">
      <MentionTextarea
        className="comment-reply-textarea"
        value={body}
        onChange={setBody}
        candidates={mentionCandidates}
        onKeyDown={onKeyDown}
        onUpload={attachmentsEnabled ? (f) => uploadCommentImage(prLocalId, f) : undefined}
        placeholder={t('commentComposer.placeholder')}
        rows={3}
        disabled={posting}
        autoFocus
        ariaLabel={t('commentComposer.textareaAria')}
      />
      <div className="comment-reply-actions">
        <button
          type="button"
          className="comment-reply-btn comment-reply-btn-primary"
          onClick={() => void handleSave()}
          disabled={!canSave}
          title={canSave ? t('commentComposer.sendTitle') : t('commentComposer.emptyTitle')}
        >
          {posting ? t('commentComposer.sending') : t('commentComposer.send')}
        </button>
        <button
          type="button"
          className="comment-reply-btn"
          onClick={onCancel}
          disabled={posting}
          title={t('commentComposer.cancelTitle')}
        >
          {t('common.cancel')}
        </button>
        {error && <span className="comment-reply-error">{error}</span>}
      </div>
    </div>
  );
}
