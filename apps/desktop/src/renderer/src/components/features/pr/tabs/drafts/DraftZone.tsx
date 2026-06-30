import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type { ReviewDraft } from '@meebox/shared';
import { ConfirmModal, TrashIcon } from '../../../../common';
import { MentionTextarea } from '../shared/MentionTextarea';
import { uploadCommentImage } from '../shared/uploadCommentImage';
import { useDraftZone } from './useDraftZone';

interface DraftZoneProps {
  draft: ReviewDraft;
  /** 所属 PR 的 localId；草稿编辑框图片上传（attachmentsEnabled 时）需用它定位 PR 附件存储。 */
  prLocalId: string;
  /** 平台是否支持图片附件上传（capabilities.commentAttachments）；为真才在草稿编辑框启用粘贴 / 选取上传。 */
  attachmentsEnabled?: boolean;
  /** 评论换行策略（活动平台 commentHardBreaks）：决定预览是否启用 remark-breaks，使草稿预览 WYSIWYG。 */
  hardBreaks: boolean;
  /**
   * 注册 "进入编辑模式" 触发函数到外部 ref map。DiffView 调用注册的 fn 时本组件
   * setIsEditing(true)。用 ref-based fn 而不是 props token，避免 trigger token 变化引发的
   * unmount/mount 循环误触（详见 useDraftZone）。
   */
  registerEditTrigger?: (draftId: string, fn: (() => void) | null) => void;
  /** 保存编辑后的 body。调用方走 IPC drafts:update。 */
  onSave: (newBody: string) => void | Promise<void>;
  /** 删除本草稿。调用方走 IPC drafts:delete */
  onDelete: () => void | Promise<void>;
  /**
   * 单条直接发布到远端。调用方走 drafts:publishBatch 传单元素 draftIds。
   * 返回 ok=false 时 error 填人读错因，本组件渲染 inline 错误但不卸载 zone。
   * 不传 = read 模式不渲染"发布"按钮。
   */
  onPublish?: () => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Diff 视图内联草稿编辑 zone。挂在 Monaco editor 的 view zone 里，由
 * `createRoot.render(<DraftZone ... />)` 渲染。read/edit/publish 状态机见 [useDraftZone](./useDraftZone.ts)；
 * 本组件只负责渲染。
 *
 * 视觉跟 CommentZone (远端评论 read-only) 区分：CommentZone 黄底 → 这里**蓝底 + DRAFT chip**；
 * posted 切绿底跟远端评论对齐；rejected 默认 css 隐藏（DiffView 端 .monaco-draft-zone-rejected）。
 */
export function DraftZone({
  draft,
  prLocalId,
  attachmentsEnabled = false,
  hardBreaks,
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
            {/* 单条"发布"：仅 pending/edited 显示 (posted 已发完不再渲染按钮；
                rejected 状态在 DiffView 端 CSS 隐藏整个 zone 不会走到这里)。
                publishing 中按钮禁用，文案改"发布中…"；其它按钮也 disable 避免
                同条草稿同时 save / delete / publish 多路并发 */}
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
            candidates={[]}
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
            {/* 主按钮：有 onPublish 时是"发布" (先 auto-save 再 POST，跟取消的
                auto-save 行为对齐避免双按钮冗余)；缺 onPublish 时退回"保存" */}
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
