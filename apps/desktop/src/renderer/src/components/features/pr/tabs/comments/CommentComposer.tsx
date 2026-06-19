import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '../../../../../api';

interface CommentComposerProps {
  prLocalId: string;
  onCancel: () => void;
  /** 发布成功后调用（收起编辑框；时间线通过 comments:changed 事件自动刷新，新评论出现在顶部） */
  onPosted: () => void;
}

/**
 * 新建 summary（不锚到文件）评论的编辑框：textarea + 发送/取消。出现在活动时间线最上方。
 * Cmd/Ctrl+Enter 发送，Esc 取消；空 body disabled 发送。版式复用回复编辑框样式。
 */
export function CommentComposer({ prLocalId, onCancel, onPosted }: CommentComposerProps) {
  const { t } = useTranslation();
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // mount 自动 focus，提升输入体感
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

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
      <textarea
        ref={textareaRef}
        className="comment-reply-textarea"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('commentComposer.placeholder')}
        rows={3}
        disabled={posting}
        aria-label={t('commentComposer.textareaAria')}
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
