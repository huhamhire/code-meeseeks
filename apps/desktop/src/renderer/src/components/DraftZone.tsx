import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type { ReviewDraft } from '@meebox/shared';
import { ConfirmModal } from './ConfirmModal';

interface DraftZoneProps {
  draft: ReviewDraft;
  /**
   * 注册 "进入编辑模式" 触发函数到外部 ref map。DiffView 调用注册的 fn 时本组件
   * setIsEditing(true)。
   *
   * 用 ref-based fn 而不是 props token，避免之前的 bug：trigger token 变化 →
   * DiffView re-render → useEffect 重跑 → DraftZone unmount/mount → 新 instance
   * 看到 token 非 undefined 又触发 setIsEditing(true)。结果：用户点取消走 auto
   * save → re-mount → 自动又进 edit，看起来"没退出"。
   *
   * ref-fn 调用不引发任何 React state change，零副作用，调一次只 enter edit 一次
   */
  registerEditTrigger?: (draftId: string, fn: (() => void) | null) => void;
  /**
   * 保存编辑后的 body。调用方走 IPC drafts:update。成功后由 drafts-store 事件流
   * 重渲染本组件 (draft prop 更新)
   */
  onSave: (newBody: string) => void | Promise<void>;
  /** 删除本草稿。调用方走 IPC drafts:delete */
  onDelete: () => void | Promise<void>;
  /**
   * 单条直接发布到远端。调用方走 drafts:publishBatch 传单元素 draftIds (跟批量
   * 路径共用 handler — main 端串行 POST + 失败收集 + 发完 force-refresh 评论)。
   * 返回单条的发布结果：ok=false 时 error 填人读错因 (BBS 4xx)，本组件渲染 inline
   * 错误提示但不卸载 zone (用户可改完 body 再点发布重试)。
   * 不传 = read 模式不渲染"发布"按钮 (e.g., 未来某些只读场景)
   */
  onPublish?: () => Promise<{ ok: boolean; error?: string }>;
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
 *   read → 显示 markdown body + chips + [发布] [编辑] [🗑] 按钮
 *   edit → textarea + [发布] [取消] [🗑] 按钮；Cmd/Ctrl+Enter = 发布，Esc = 取消
 *
 * 关键交互约定：
 * - 取消 = 1) editing+persisted 都空 → 删除真空草稿避免占位；
 *         2) editing 空 + persisted 非空 → revert 退出 (用户清空 textarea 可能误操作)；
 *         3) editing 跟 persisted 一样 → 直接退出 edit；
 *         4) editing 跟 persisted 不同 → **自动保存** (不弹 confirm)，最贴近用户直觉
 * - 发布 (edit 模式) = 先 auto-save 当前 editingBody，再走 onPublish。设计动机：
 *   取消既然已经 auto-save dirty，独立的"保存"按钮就冗余了 —— 用户在 edit 编辑完
 *   最自然的下一步是发布，合并成一次点击。失败 (BBS 4xx) 不退 edit，让用户改后重试
 * - 发布 (read 模式) = 直接 onPublish，body 取盘上 persisted 值
 * - 删除 = 独立 [🗑] 按钮，body 非空时弹 ConfirmModal 二次确认；空草稿直接删
 *
 * 没传 onPublish 时 (only happens in hypothetical read-only context) edit 按钮组
 * 退回老的"保存"按钮
 *
 * onSave 触发后等 drafts-store 事件流推回新 draft prop，useEffect 把 isEditing
 * 收回 read 模式。乐观更新 UI：onSave 调用后立即把本地 editingBody 同步到下次
 * draft.body 比较，保证 UI 不闪烁
 */
export function DraftZone({
  draft,
  registerEditTrigger,
  onSave,
  onDelete,
  onPublish,
}: DraftZoneProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editingBody, setEditingBody] = useState(draft.body);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Ref 跟踪最新 state / props，供 unmount cleanup 闭包同步读
  const editingBodyRef = useRef(editingBody);
  const isEditingRef = useRef(isEditing);
  const draftBodyRef = useRef(draft.body);
  useEffect(() => {
    editingBodyRef.current = editingBody;
  }, [editingBody]);
  useEffect(() => {
    isEditingRef.current = isEditing;
  }, [isEditing]);
  useEffect(() => {
    draftBodyRef.current = draft.body;
  }, [draft.body]);

  // 显式 mutate 标记 — 区分 "用户主动操作触发 unmount" vs "切换文件触发 unmount"。
  // 设计：mutate 入口设 true (handleSave/Cancel/Delete 各种路径)；进 edit 时重置
  // false (new editing session 没显式意图)。**不在 finally 清** — 因为 mutate IPC
  // 完成跟 drafts:changed 引发的 unmount 时序不可控，清得太早会让 cleanup 误判。
  // 锁的生命周期跟随 component instance：mutate 后保留 true 直到 unmount 或下次进
  // edit 时被重置
  const isMutatingRef = useRef(false);
  useEffect(() => {
    if (isEditing) isMutatingRef.current = false;
  }, [isEditing]);

  // 统一的 cancel 四档逻辑 — handleCancel / unmount cleanup / Esc 共用
  // (避免三个地方分别实现引起行为漂移)。读 ref 拿最新值，支持 fire-and-forget
  const runCancelLogic = (): void => {
    const editing = editingBodyRef.current.trim();
    const persisted = draftBodyRef.current.trim();
    if (!editing && !persisted) {
      void onDelete();
      return;
    }
    if (!editing) {
      // 空 + 有 → revert (unmount 时 no-op，state 已销毁；handleCancel 时设 state)
      setEditingBody(draftBodyRef.current);
      setIsEditing(false);
      return;
    }
    if (editingBodyRef.current === draftBodyRef.current) {
      setIsEditing(false);
      return;
    }
    // dirty → auto save
    void onSave(editingBodyRef.current);
    setIsEditing(false);
  };

  // unmount cleanup — 切换文件 / PR / tab 触发。跟取消按钮共用 runCancelLogic 让
  // 行为完全一致。isMutating=true 时跳过 (用户已经显式 mutate 接管，不需要 cleanup
  // 兜底，避免跟 IPC 形成 race)
  useEffect(() => {
    return () => {
      if (isMutatingRef.current) return;
      if (!isEditingRef.current) return;
      runCancelLogic();
    };
    // 空 deps：mount/unmount 跑；runCancelLogic 内部全 ref 读，无 closure 失效问题
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 把 "进入编辑模式" 触发器注册到 DiffView 的 ref map。register 是稳定函数引用
  // (DiffView 用 useCallback 包)，draft.id 不变 → effect 只在 mount/unmount 跑。
  // 调用 fn 不引发 React state change in DiffView side → 没有 re-render → 没有
  // unmount/mount 循环，进 edit 一次只一次
  useEffect(() => {
    registerEditTrigger?.(draft.id, () => {
      setIsEditing(true);
      setEditingBody(draftBodyRef.current);
    });
    return () => registerEditTrigger?.(draft.id, null);
  }, [draft.id, registerEditTrigger]);

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

  // textarea 的 React onKeyDown 在 React 18 root delegation 下走 bubble 阶段，
  // monaco 在 editor container 上的 capture-stage keydown listener 可能在事件
  // 冒泡前就 stopPropagation 吞掉 Esc，导致 textarea 的 onKeyDown 永远不触发。
  // 兜底：window 顶层 capture listener，textarea focus 时按 Esc 走 runCancelLogic
  // (跟取消按钮 / unmount cleanup 共用) + 设 isMutatingRef=true 让 cleanup 跳过
  useEffect(() => {
    if (!isEditing) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (document.activeElement !== textareaRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      isMutatingRef.current = true;
      runCancelLogic();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // runCancelLogic 是局部 fn，不放 deps；isEditing 切回时移除 listener
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  const status = draft.status;
  // posted 不应该再被编辑；UI 上隐藏编辑/删除按钮，整体灰显
  const canEdit = status !== 'posted';
  // rejected 草稿默认隐藏（DiffView 端样式控制）；本组件渲染时也不挂 zone

  const trimmedEditing = editingBody.trim();
  // 评论不能为空：trim 后无字符不允许保存。提交按钮 disabled + 按钮 title 解释
  const canSave = trimmedEditing.length > 0;

  const handleSave = async (): Promise<void> => {
    if (saving) return;
    if (!canSave) return; // 防御：除按钮 disabled 外双保险
    if (trimmedEditing === draft.body.trim()) {
      // 没改 → 退回 read 不调 IPC
      setIsEditing(false);
      return;
    }
    isMutatingRef.current = true;
    setSaving(true);
    try {
      await onSave(editingBody);
      // 等 store 事件回来后 draft.body 更新，但乐观先退出 edit；体感更顺
      setIsEditing(false);
    } finally {
      setSaving(false);
    }
  };

  // 单条直接发布。仅 pending/edited 可发；body 空也不发 (BBS 拒绝空评论)。
  // 不弹 confirm — 单条评论的"发布"心智跟"批量评审"不同，是即时操作；要二次
  // 确认放在批量入口的 PublishReviewModal 那一层做就够了
  const handlePublish = async (): Promise<void> => {
    if (!onPublish || publishing) return;
    if (status === 'posted' || status === 'rejected') return;
    if (!draft.body.trim()) return;
    isMutatingRef.current = true;
    setPublishError(null);
    setPublishing(true);
    try {
      const res = await onPublish();
      if (!res.ok) {
        setPublishError(res.error ?? '发布失败');
      }
      // 成功 → drafts-store 广播让 status 切到 'posted'，组件自动 re-render 显示
      // posted chip + 远端 id。无需手动 setIsEditing 之类，draft prop 流推回
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : String(e));
    } finally {
      setPublishing(false);
    }
  };

  // edit 模式的"发布" — 先 save 当前 textarea 内容到本地，再调 publish。
  // 设计动机：取消按钮已经有 dirty auto-save 语义，独立的"保存"按钮反而冗余；
  // 用户在 edit 改完最自然的下一步是发布，合并一次点击。
  // - 保存失败 (本地写盘几乎不会) → 仍尝试发布；publish 端读盘拿到的是 main 上
  //   一次成功的 body，对用户没有静默错误风险
  // - 发布失败 (BBS 4xx) → 留在 edit 让用户改 body 重试，inline error 提示
  const handlePublishFromEdit = async (): Promise<void> => {
    if (!onPublish || publishing) return;
    if (!canSave) return;
    isMutatingRef.current = true;
    setPublishError(null);
    // 先持久化本次 editing 内容 — onPublish 通过 main store 读盘拿 body，必须
    // 保证盘上是用户刚改的最新版本
    if (editingBody !== draft.body) {
      setSaving(true);
      try {
        await onSave(editingBody);
      } finally {
        setSaving(false);
      }
    }
    setPublishing(true);
    try {
      const res = await onPublish();
      if (res.ok) {
        setIsEditing(false);
      } else {
        setPublishError(res.error ?? '发布失败');
      }
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : String(e));
    } finally {
      setPublishing(false);
    }
  };

  const handleCancel = async (): Promise<void> => {
    // 取消复用 runCancelLogic (跟 unmount cleanup 共用)。区别：handleCancel 主动
    // 设 isMutatingRef=true (用户显式操作)，让 cleanup 知道意图已被接管
    isMutatingRef.current = true;
    // 内部 dirty 分支需要 await save 才退 edit，单独走一遍含 await 的版本：
    const editingTrim = editingBody.trim();
    const persistedTrim = draft.body.trim();
    if (!editingTrim && !persistedTrim) {
      void onDelete();
      return;
    }
    if (!editingTrim) {
      setEditingBody(draft.body);
      setIsEditing(false);
      return;
    }
    if (editingBody === draft.body) {
      setIsEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(editingBody);
      setIsEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (): void => {
    // body 非空（含编辑中的草稿）→ 弹 ConfirmModal 二次确认；空草稿直接删。
    // edit 模式下用 editingBody 判（用户可能在 textarea 输入很多还没保存就点删除）
    const currentBody = (isEditing ? editingBody : draft.body).trim();
    if (currentBody) {
      setConfirmDelete(true);
      return;
    }
    isMutatingRef.current = true;
    void onDelete();
  };

  const handleConfirmDelete = async (): Promise<void> => {
    setConfirmDelete(false);
    isMutatingRef.current = true;
    await onDelete();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      // Cmd/Ctrl+Enter 优先走"发布" (跟新的主按钮一致)；onPublish 缺失场景退回保存
      e.preventDefault();
      if (onPublish) {
        void handlePublishFromEdit();
      } else {
        void handleSave();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      void handleCancel();
    }
  };

  // 取消按钮动态文案：textarea 有内容 → "暂存"，明示点击不丢内容；textarea
  // 完全空 → "取消"，对应"退出 edit 不留草稿"的语义 (runCancelLogic 此时会删
  // 真空草稿 / revert)。
  // 不再用"dirty (editing != persisted)"作判据 — 用户进 edit 看到已存的旧内容
  // 没改也"有文字"，按用户心智应该是暂存 (即使内部走 no-op 直接退出 edit)
  const cancelLabel = trimmedEditing ? '暂存' : '取消';

  const statusLabel: Record<typeof status, string> = {
    pending: '待处理',
    edited: '已编辑',
    posted: '已发布',
    rejected: '已拒绝',
  };

  return (
    <div className={`draft-zone-inner draft-zone-status-${status}`}>
      <div className="draft-zone-head">
        <span className="draft-zone-tag">草稿</span>
        <span className={`draft-zone-status draft-zone-status-chip-${status}`}>
          {statusLabel[status]}
        </span>
        <span className="draft-zone-origin muted">
          {draft.origin === 'finding' ? 'AI 建议' : '我的评论'}
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
                    ? '空草稿不能发布；先点编辑写入内容'
                    : '发布到 BBS (这一条)'
                }
              >
                {publishing ? '发布中…' : '发布'}
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
              title="编辑评论"
            >
              编辑
            </button>
            <button
              type="button"
              className="draft-zone-btn draft-zone-btn-icon draft-zone-btn-danger"
              onClick={() => void handleDelete()}
              disabled={publishing}
              title="删除草稿（本地，不影响远端）"
              aria-label="删除草稿"
            >
              <TrashIcon />
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
            disabled={saving || publishing}
            aria-label="草稿评论编辑器"
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
                  !canSave
                    ? '评论不能为空'
                    : '发布到 BBS (Cmd/Ctrl+Enter，会先自动保存当前内容)'
                }
              >
                {publishing ? '发布中…' : saving ? '保存中…' : '发布'}
              </button>
            ) : (
              <button
                type="button"
                className="draft-zone-btn draft-zone-btn-primary"
                onClick={() => void handleSave()}
                disabled={saving || !canSave}
                title={!canSave ? '评论不能为空' : '保存 (Cmd/Ctrl+Enter)'}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            )}
            <button
              type="button"
              className="draft-zone-btn"
              onClick={() => void handleCancel()}
              disabled={saving || publishing}
              title={
                cancelLabel === '暂存'
                  ? '暂存改动 (本地保留，未发布；Esc 同效)'
                  : '取消 (Esc)'
              }
            >
              {cancelLabel}
            </button>
            {canEdit && (
              <button
                type="button"
                className="draft-zone-btn draft-zone-btn-icon draft-zone-btn-danger draft-zone-edit-delete"
                onClick={() => void handleDelete()}
                disabled={saving || publishing}
                title="删除草稿（有内容时二次确认）"
                aria-label="删除草稿"
              >
                <TrashIcon />
              </button>
            )}
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
      {publishError && (
        <div className="draft-zone-publish-error" role="alert">
          发布失败：{publishError}
          <button
            type="button"
            className="draft-zone-publish-error-dismiss"
            onClick={() => setPublishError(null)}
            aria-label="关闭错误提示"
            title="知道了"
          >
            ✕
          </button>
        </div>
      )}
      {confirmDelete && (
        <ConfirmModal
          title="删除草稿"
          message="此草稿包含内容，删除后无法恢复。确定删除吗？"
          confirmLabel="删除"
          cancelLabel="取消"
          danger
          onConfirm={() => void handleConfirmDelete()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

/**
 * 14×14 垃圾桶图标，stroke 用 currentColor 跟按钮文字色继承。aria-hidden
 * 由调用方在 button 上加 aria-label
 */
function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M2.5 4h11M6.5 7v5M9.5 7v5M3.5 4l.7 8.5a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9L12.5 4M6 4V2.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
