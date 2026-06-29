import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlatformUser } from '@meebox/shared';
import { invoke } from '../../../../../api';
import { MentionTextarea } from '../shared/MentionTextarea';

interface CommentComposerProps {
  prLocalId: string;
  /** `@提及` 自动补全候选（PR 参与者 + 评论作者，由父组件从已加载数据派生）。 */
  mentionCandidates?: PlatformUser[];
  /** 平台是否支持图片附件上传（capabilities.commentAttachments）；为真才启用粘贴上传。 */
  attachmentsEnabled?: boolean;
  onCancel: () => void;
  /** 发布成功后调用（收起编辑框；时间线通过 comments:changed 事件自动刷新，新评论出现在顶部） */
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
 * 新建 summary（不锚到文件）评论的编辑框：textarea + 发送/取消。出现在活动时间线最上方。
 * Cmd/Ctrl+Enter 发送，Esc 取消；空 body disabled 发送。版式复用回复编辑框样式。
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
        onUpload={attachmentsEnabled ? (f) => uploadImage(prLocalId, f) : undefined}
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
