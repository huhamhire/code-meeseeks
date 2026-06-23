import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewDraft } from '@meebox/shared';
import { formatBackendError } from '../../../../../errors';

export interface UseDraftZoneParams {
  draft: ReviewDraft;
  registerEditTrigger?: (draftId: string, fn: (() => void) | null) => void;
  onSave: (newBody: string) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onPublish?: () => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Diff 内联草稿 zone 的 read/edit/publish 状态机。把全部 state / ref / effect / handler 收敛于此，
 * DraftZone 组件只消费返回值做渲染。
 *
 * 取消四档逻辑（runCancelLogic）被取消按钮 / unmount cleanup / Esc 三处共用，全靠 ref 读最新值，
 * 保持「三处行为完全一致」的现有约定 —— 整体留在 hook 内，调用点都指向同一函数。
 */
export function useDraftZone({
  draft,
  registerEditTrigger,
  onSave,
  onDelete,
  onPublish,
}: UseDraftZoneParams) {
  const { t } = useTranslation();
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

  // 单条直接发布。仅 pending/edited 可发；body 空也不发 (Bitbucket 拒绝空评论)。
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
        setPublishError(
          res.error ? formatBackendError(res.error).title : t('draftZone.publishFailed'),
        );
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
  // - 发布失败 (Bitbucket 4xx) → 留在 edit 让用户改 body 重试，inline error 提示
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
        setPublishError(
          res.error ? formatBackendError(res.error).title : t('draftZone.publishFailed'),
        );
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
  // textarea 有内容 → 暂存语义；空 → 取消语义。stash 标志驱动按钮文案与 title
  const isStash = trimmedEditing.length > 0;
  const cancelLabel = isStash ? t('draftZone.stash') : t('common.cancel');

  return {
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
  };
}
