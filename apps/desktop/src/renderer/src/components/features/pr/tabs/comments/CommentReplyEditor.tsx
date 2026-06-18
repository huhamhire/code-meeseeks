import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '../../../../../api';

interface CommentReplyEditorProps {
  prLocalId: string;
  parentCommentId: string;
  onCancel: () => void;
  /** reply 创建成功后调用 (UI 收起编辑框；评论列表通过 comments:changed 事件自动刷新) */
  onPosted: () => void;
}

/**
 * 已有评论的人工回复编辑框：textarea + 保存/取消。展开在被回复评论的下方。
 * Cmd/Ctrl+Enter 保存，Esc 取消；空 body disabled 保存
 */
export function CommentReplyEditor({
  prLocalId,
  parentCommentId,
  onCancel,
  onPosted,
}: CommentReplyEditorProps) {
  const { t } = useTranslation();
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // mount 自动 focus，提升用户输入体感
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

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
      <textarea
        ref={textareaRef}
        className="comment-reply-textarea"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('commentReplyEditor.placeholder')}
        rows={3}
        disabled={posting}
        aria-label={t('commentReplyEditor.textareaAria')}
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
