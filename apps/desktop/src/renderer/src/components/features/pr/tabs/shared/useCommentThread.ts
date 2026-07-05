import { useState } from 'react';
import type { PrComment } from '@meebox/shared';
import { invoke } from '../../../../../api';

/**
 * Interaction state machine for a single comment's "reply / edit / delete". The comment/activity tab's CommentItem and the diff inline
 * comment zone's CommentNode share the same logic (IPC calls, state transitions, permission reads are identical), differing only in the shell
 * (CSS classes / i18n text / layout).
 *
 * canEdit / canDelete are predetermined by main (annotateOwnership); the renderer reads the flag directly, no longer comparing
 * author / version / replies itself. After a successful delete, main clears the cache + broadcasts comments:changed, the upper panel/zone
 * refetches comments, this one naturally disappears from the list, no local maintenance needed.
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
      // Success → main clears the cache + broadcasts comments:changed → upper layer refetches, this comment naturally disappears
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
