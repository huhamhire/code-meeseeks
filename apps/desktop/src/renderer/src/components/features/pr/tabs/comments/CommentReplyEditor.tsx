import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlatformKind, PlatformUser } from '@meebox/shared';
import { invoke } from '../../../../../api';
import { MentionTextarea } from '../shared/MentionTextarea';
import { searchMentionUsers } from '../shared/mentionSearch';
import { uploadCommentImage } from '../shared/uploadCommentImage';

interface CommentReplyEditorProps {
  prLocalId: string;
  parentCommentId: string;
  /** `@mention` autocomplete candidates (PR participants + comment authors). */
  mentionCandidates?: PlatformUser[];
  /** Active platform, deciding inserted mention syntax (Bitbucket quotes non-simple usernames). */
  platform?: PlatformKind;
  /** Whether the platform supports image attachment upload; paste upload is enabled only when true. */
  attachmentsEnabled?: boolean;
  /** Whether the platform supports remote user search (capabilities.userSearch); enables the mention editor's remote fallback when true. */
  userSearchEnabled?: boolean;
  onCancel: () => void;
  /** Called after a reply is created successfully (UI collapses the editor; the comment list auto-refreshes via the comments:changed event) */
  onPosted: () => void;
}

/**
 * Manual reply editor for an existing comment: textarea + save/cancel. Expands below the comment being replied to.
 * Cmd/Ctrl+Enter to save, Esc to cancel; empty body disables save
 */
export function CommentReplyEditor({
  prLocalId,
  parentCommentId,
  mentionCandidates = [],
  platform,
  attachmentsEnabled = false,
  userSearchEnabled = false,
  onCancel,
  onPosted,
}: CommentReplyEditorProps) {
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
      await invoke('comments:reply', { localId: prLocalId, parentCommentId, body });
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
        platform={platform}
        onRemoteSearch={
          userSearchEnabled ? (q) => searchMentionUsers(prLocalId, q) : undefined
        }
        onKeyDown={onKeyDown}
        onUpload={attachmentsEnabled ? (f) => uploadCommentImage(prLocalId, f) : undefined}
        placeholder={t('commentReplyEditor.placeholder')}
        rows={3}
        disabled={posting}
        autoFocus
        ariaLabel={t('commentReplyEditor.textareaAria')}
      />
      <div className="comment-reply-actions">
        <button
          type="button"
          className="comment-reply-btn comment-reply-btn-primary"
          onClick={() => void handleSave()}
          disabled={!canSave}
          title={canSave ? t('commentReplyEditor.sendTitle') : t('commentReplyEditor.emptyTitle')}
        >
          {posting ? t('commentReplyEditor.sending') : t('commentReplyEditor.send')}
        </button>
        <button
          type="button"
          className="comment-reply-btn"
          onClick={onCancel}
          disabled={posting}
          title={t('commentReplyEditor.cancelTitle')}
        >
          {t('common.cancel')}
        </button>
        {error && <span className="comment-reply-error">{error}</span>}
      </div>
    </div>
  );
}
