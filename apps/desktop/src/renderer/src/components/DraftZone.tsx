import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type { ReviewDraft } from '@pr-pilot/shared';

interface DraftZoneProps {
  draft: ReviewDraft;
  /**
   * 自外部触发"进入编辑模式"的 token；每次值变化都强制 enter edit mode。
   * 用于：ChatPane "→ 跳到代码编辑" / 行 hover '+' 新建后；用 number 单调递增
   * 让 useEffect dep 比较能识别"再次请求"。
   *
   * 也接 'create' 字面值作为初次挂载就自动 edit 的提示 (manual 新建草稿场景)
   */
  autoEditToken?: number;
  /**
   * 保存编辑后的 body。调用方走 IPC drafts:update。成功后由 drafts-store 事件流
   * 重渲染本组件 (draft prop 更新)
   */
  onSave: (newBody: string) => void | Promise<void>;
  /** 删除本草稿。调用方走 IPC drafts:delete */
  onDelete: () => void | Promise<void>;
}

/**
 * Diff 视图内联草稿编辑 zone。挂在 Monaco editor 的 view zone 里，由
 * `createRoot.render(<DraftZone ... />)` 渲染。
 *
 * 视觉跟现有 CommentZone (远端评论 read-only) 区分：
 * - CommentZone 黄底 (BBS 远端) → 这里**蓝底 + DRAFT chip**
 * - posted 状态切回绿底跟远端评论形态对齐 (含远端 comment id 链接)
 * - rejected 状态默认 css 隐藏 (DiffView 端 .monaco-draft-zone-rejected 上设)
 *
 * 状态机：内部 isEditing 控 read / edit 模式
 *   read → 显示 markdown body + chips + [编辑] [删除] 按钮
 *   edit → textarea + [保存] [取消] 按钮；Cmd/Ctrl+Enter = 保存，Esc = 取消
 *
 * onSave 触发后等 drafts-store 事件流推回新 draft prop，useEffect 把 isEditing
 * 收回 read 模式。乐观更新 UI：onSave 调用后立即把本地 editingBody 同步到下次
 * draft.body 比较，保证 UI 不闪烁
 */
export function DraftZone({ draft, autoEditToken, onSave, onDelete }: DraftZoneProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editingBody, setEditingBody] = useState(draft.body);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // autoEditToken 变化 → 强制 enter edit (来自 ChatPane 跳转 or hover+ 新建)
  useEffect(() => {
    if (autoEditToken !== undefined) {
      setIsEditing(true);
      setEditingBody(draft.body);
    }
    // 故意不依赖 draft.body —— 不想用户编辑过程中 draft 变化覆盖输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditToken]);

  // draft.body 外部变化 (e.g., 队列写回) + 当前非 editing → 同步 editingBody
  useEffect(() => {
    if (!isEditing) setEditingBody(draft.body);
  }, [draft.body, isEditing]);

  // 进入 edit 时 focus + 光标到末尾
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      const el = textareaRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [isEditing]);

  const status = draft.status;
  // posted 不应该再被编辑；UI 上隐藏编辑/删除按钮，整体灰显
  const canEdit = status !== 'posted';
  // rejected 草稿默认隐藏（DiffView 端样式控制）；本组件渲染时也不挂 zone

  const handleSave = async (): Promise<void> => {
    if (saving) return;
    const trimmed = editingBody.trim();
    if (trimmed === draft.body.trim()) {
      // 没改 → 退回 read 不调 IPC
      setIsEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(editingBody);
      // 等 store 事件回来后 draft.body 更新，但乐观先退出 edit；体感更顺
      setIsEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = (): void => {
    setEditingBody(draft.body);
    setIsEditing(false);
  };

  const handleDelete = async (): Promise<void> => {
    // 不弹 confirm —— rejected 草稿后续可恢复 (M4 P2)；这里用户误删的代价低
    await onDelete();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  };

  const statusLabel: Record<typeof status, string> = {
    pending: '待处理',
    edited: '已编辑',
    posted: '已发布',
    rejected: '已拒绝',
  };

  return (
    <div className={`draft-zone-inner draft-zone-status-${status}`}>
      <div className="draft-zone-head">
        <span className="draft-zone-tag">DRAFT</span>
        <span className={`draft-zone-status draft-zone-status-chip-${status}`}>
          {statusLabel[status]}
        </span>
        <span className="draft-zone-origin muted">
          {draft.origin === 'finding' ? 'AI 建议' : '我的评论'}
        </span>
        {!isEditing && canEdit && (
          <div className="draft-zone-actions">
            <button
              type="button"
              className="draft-zone-btn"
              onClick={() => {
                setEditingBody(draft.body);
                setIsEditing(true);
              }}
              title="编辑评论 (Cmd/Ctrl+Enter 保存)"
            >
              编辑
            </button>
            <button
              type="button"
              className="draft-zone-btn draft-zone-btn-danger"
              onClick={() => void handleDelete()}
              title="删除草稿（本地，不影响远端）"
            >
              删除
            </button>
          </div>
        )}
      </div>
      {isEditing ? (
        <div className="draft-zone-edit">
          <textarea
            ref={textareaRef}
            className="draft-zone-textarea"
            value={editingBody}
            onChange={(e) => setEditingBody(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="写一条评论..."
            rows={4}
            disabled={saving}
            aria-label="草稿评论编辑器"
          />
          <div className="draft-zone-edit-actions">
            <button
              type="button"
              className="draft-zone-btn draft-zone-btn-primary"
              onClick={() => void handleSave()}
              disabled={saving}
              title="保存 (Cmd/Ctrl+Enter)"
            >
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="draft-zone-btn"
              onClick={handleCancel}
              disabled={saving}
              title="取消 (Esc)"
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="draft-zone-body markdown">
          {draft.body.trim() ? (
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{draft.body}</ReactMarkdown>
          ) : (
            <span className="muted">(空草稿；点编辑写入内容)</span>
          )}
        </div>
      )}
      {draft.posted_remote_id && (
        <div className="draft-zone-foot muted">已发布 · 远端 id: {draft.posted_remote_id}</div>
      )}
    </div>
  );
}
