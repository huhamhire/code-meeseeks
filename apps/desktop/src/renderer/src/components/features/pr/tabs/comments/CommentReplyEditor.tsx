import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlatformUser } from '@meebox/shared';
import { invoke } from '../../../../../api';
import { MentionTextarea } from '../shared/MentionTextarea';

interface CommentReplyEditorProps {
  prLocalId: string;
  parentCommentId: string;
  /** `@提及` 自动补全候选（PR 参与者 + 评论作者）。 */
  mentionCandidates?: PlatformUser[];
  /** 平台是否支持图片附件上传；为真才启用粘贴上传。 */
  attachmentsEnabled?: boolean;
  onCancel: () => void;
  /** reply 创建成功后调用 (UI 收起编辑框；评论列表通过 comments:changed 事件自动刷新) */
  onPosted: () => void;
}

/** 把粘贴的图片 File 经 IPC 上传、返回可插入的 markdown（上传失败 / 不支持回 null）。 */
async function uploadImage(prLocalId: string, file: File): Promise<string | null> {
  const bytes = await file.arrayBuffer();
  const res = await invoke('comments:uploadAttachment', {
    localId: prLocalId,
    fileName: file.name || 'image.png',
    contentType: file.type || 'image/png',
    bytes,
  });
  return res?.markdown ?? null;
}

/**
 * 已有评论的人工回复编辑框：textarea + 保存/取消。展开在被回复评论的下方。
 * Cmd/Ctrl+Enter 保存，Esc 取消；空 body disabled 保存
 */
export function CommentReplyEditor({
  prLocalId,
  parentCommentId,
  mentionCandidates = [],
  attachmentsEnabled = false,
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
        onKeyDown={onKeyDown}
        onUpload={attachmentsEnabled ? (f) => uploadImage(prLocalId, f) : undefined}
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
