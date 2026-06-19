import { useState } from 'react';
import type { PrComment } from '@meebox/shared';
import { invoke } from '../../../../../api';

/**
 * 单条评论的「回复 / 编辑 / 删除」交互状态机。评论/活动 tab 的 CommentItem 与 diff 行内
 * 评论 zone 的 CommentNode 共用同一份逻辑（IPC 调用、状态转移、权限读取完全一致），仅外壳
 * （CSS 类 / i18n 文案 / 版式）各异。
 *
 * canEdit / canDelete 由 main 端预判（annotateOwnership），renderer 直读 flag，不再自己比对
 * author / version / replies。删除成功后 main 端清 cache + 广播 comments:changed，上层面板/zone
 * 重拉评论，这条自然从列表消失，无需本地维护。
 */
export interface CommentThread {
  replyOpen: boolean;
  setReplyOpen: (v: boolean) => void;
  editOpen: boolean;
  setEditOpen: (v: boolean) => void;
  confirmDelete: boolean;
  setConfirmDelete: (v: boolean) => void;
  deleting: boolean;
  deleteError: string | null;
  setDeleteError: (v: string | null) => void;
  canEdit: boolean;
  canDelete: boolean;
  handleDelete: () => Promise<void>;
}

export function useCommentThread(prLocalId: string, comment: PrComment): CommentThread {
  const [replyOpen, setReplyOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const canDelete = comment.canDelete === true;
  const canEdit = comment.canEdit === true;

  const handleDelete = async (): Promise<void> => {
    if (!canDelete || comment.version === undefined) return;
    setConfirmDelete(false);
    setDeleting(true);
    setDeleteError(null);
    try {
      await invoke('comments:delete', {
        localId: prLocalId,
        commentId: comment.remoteId,
        version: comment.version,
      });
      // 成功 → main 端清 cache + 广播 comments:changed → 上层重拉，这条评论自然消失
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  };

  return {
    replyOpen,
    setReplyOpen,
    editOpen,
    setEditOpen,
    confirmDelete,
    setConfirmDelete,
    deleting,
    deleteError,
    setDeleteError,
    canEdit,
    canDelete,
    handleDelete,
  };
}
