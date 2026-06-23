import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '../../../../../api';

interface CommentEditEditorProps {
  prLocalId: string;
  commentId: string;
  /** 当前评论 version (乐观锁，Bitbucket PUT 必带)；版本不一致 Bitbucket 回 409 */
  version: number;
  /** 初始 body — 进编辑态时 textarea 预填，避免用户从空白重写 */
  initialBody: string;
  onCancel: () => void;
  /** 保存成功后调用：UI 收起编辑器；评论树通过 comments:changed 事件自动刷新 */
  onSaved: () => void;
}

/**
 * 已有评论的编辑器：textarea + 保存/取消，跟 CommentReplyEditor 同套视觉与
 * 快捷键 (Cmd/Ctrl+Enter 保存，Esc 取消)。
 *
 * 跟 reply 区别：
 * - 初始 body = 现有评论文本，进编辑后用户改的是已存内容而非新建
 * - 走 comments:edit IPC (PUT)，必须带 version
 * - body 没变时禁用保存按钮 (no-op 不调远端)
 * - 失败常见情形：Bitbucket 409 (用户在别处先改过 → version 错位) — 错误原文直接
 *   显示在编辑器底部，用户看到提示后可以关闭编辑器、等评论树刷新后再次编辑
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

  // mount 自动 focus + 光标到末尾，方便接着原文继续打字
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
