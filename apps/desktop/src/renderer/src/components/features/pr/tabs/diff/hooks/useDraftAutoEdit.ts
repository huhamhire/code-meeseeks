import { useCallback, useEffect, useRef } from 'react';
import type { StoredPullRequest } from '@meebox/shared';

export interface DraftAutoEdit {
  registerEditTrigger: (draftId: string, fn: (() => void) | null) => void;
  triggerAutoEdit: (draftId: string) => void;
}

/**
 * autoEdit 触发器表：draft.id → "进入编辑模式" fn。供两个来源用：
 *   1. ChatPane → App.pendingDiffNav 跳转完后，目标 draft 自动 enter edit
 *   2. 行 hover '+' 创建 manual draft 后立即 enter edit (新草稿空 body 必须能输入)
 *
 * 用 ref-based fn 而不是 state token。token 方案曾导致 bug：用户取消 → auto save → drafts store
 * 变 → DiffView re-render → DraftZone unmount/mount → 新 instance 看到 props token 仍非 undefined
 * 又 setIsEditing(true) → 用户看似"取消没生效"。ref-fn 调用纯副作用，不引发 re-render。
 */
export function useDraftAutoEdit(pr: StoredPullRequest): DraftAutoEdit {
  const editTriggerFnsRef = useRef<Map<string, () => void>>(new Map());
  // pending trigger 兜底：triggerAutoEdit 调用时 DraftZone 还没 mount + register
  // (典型场景：hover '+' 创建后立即 trigger，drafts store 异步更新)。fn 不在 map
  // 时把 id 加 pending；registerEditTrigger 时如果发现自己 pending 立即 fire
  const pendingTriggersRef = useRef<Set<string>>(new Set());
  const registerEditTrigger = useCallback((draftId: string, fn: (() => void) | null): void => {
    if (fn) {
      editTriggerFnsRef.current.set(draftId, fn);
      if (pendingTriggersRef.current.has(draftId)) {
        pendingTriggersRef.current.delete(draftId);
        fn();
      }
    } else {
      editTriggerFnsRef.current.delete(draftId);
    }
  }, []);
  const triggerAutoEdit = (draftId: string): void => {
    const fn = editTriggerFnsRef.current.get(draftId);
    if (fn) {
      fn();
    } else {
      pendingTriggersRef.current.add(draftId);
    }
  };

  // PR 切换清掉所有 trigger fn 引用 + pending (新 PR 的 DraftZone 会重新注册)
  useEffect(() => {
    editTriggerFnsRef.current.clear();
    pendingTriggersRef.current.clear();
  }, [pr.localId]);

  return { registerEditTrigger, triggerAutoEdit };
}
