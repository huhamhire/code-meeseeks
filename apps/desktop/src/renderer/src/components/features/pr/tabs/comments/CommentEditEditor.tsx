import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '../../../../../api';

interface CommentEditEditorProps {
  prLocalId: string;
  commentId: string;
  /** Current comment version (optimistic lock, required for Bitbucket PUT); Bitbucket returns 409 on version mismatch */
  version: number;
  /** Initial body — prefills the textarea when entering edit mode, so the user does not rewrite from blank */
  initialBody: string;
  onCancel: () => void;
  /** Called after a successful save: UI collapses the editor; the comment tree auto-refreshes via the comments:changed event */
  onSaved: () => void;
}

/**
 * Editor for an existing comment: textarea + save/cancel, sharing the same visuals and
 * shortcuts as CommentReplyEditor (Cmd/Ctrl+Enter to save, Esc to cancel).
 *
 * Differences from reply:
 * - Initial body = existing comment text; after entering edit mode the user modifies stored content rather than creating new
 * - Goes through the comments:edit IPC (PUT), must carry version
 * - Save button is disabled when body is unchanged (no-op, does not call remote)
 * - Common failure: Bitbucket 409 (user edited elsewhere first → version mismatch) — the raw error is shown
 *   directly at the bottom of the editor; after seeing it the user can close the editor and re-edit once the comment tree refreshes
 */
export function CommentEditEditor({
  prLocalId,
  commentId,
  version,
  initialBody,
  onCancel,
  onSaved,
}: CommentEditEditorProps) {
  const { t } = useTranslation();
  const [body, setBody] = useState(initialBody);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // On mount, auto-focus + move cursor to the end, so typing continues from the existing text
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);

  const trimmed = body.trim();
  const changed = body !== initialBody;
  const canSave = trimmed.length > 0 && changed && !saving;

  const handleSave = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await invoke('comments:edit', {
        localId: prLocalId,
        commentId,
        version,
        body,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
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
    <div className="comment-reply-editor comment-edit-editor">
      <textarea
        ref={textareaRef}
        className="comment-reply-textarea"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('commentEditEditor.placeholder')}
        rows={3}
        disabled={saving}
        aria-label={t('commentEditEditor.textareaAria')}
      />
      <div className="comment-reply-actions">
        <button
          type="button"
          className="comment-reply-btn comment-reply-btn-primary"
          onClick={() => void handleSave()}
          disabled={!canSave}
          title={
            !trimmed
              ? t('commentEditEditor.emptyTitle')
              : !changed
                ? t('commentEditEditor.unchangedTitle')
                : t('commentEditEditor.saveTitle')
          }
        >
          {saving ? t('commentEditEditor.saving') : t('common.save')}
        </button>
        <button
          type="button"
          className="comment-reply-btn"
          onClick={onCancel}
          disabled={saving}
          title={t('commentEditEditor.cancelTitle')}
        >
          {t('common.cancel')}
        </button>
        {error && <span className="comment-reply-error">{error}</span>}
      </div>
    </div>
  );
}
