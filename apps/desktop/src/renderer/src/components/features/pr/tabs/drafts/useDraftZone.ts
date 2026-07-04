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
 * read/edit/publish state machine for the Diff inline draft zone. Converges all state / ref / effect / handler here,
 * the DraftZone component only consumes the return value to render.
 *
 * The four-branch cancel logic (runCancelLogic) is shared by the cancel button / unmount cleanup / Esc, all reading the latest
 * value via refs, keeping the existing convention that "all three behave identically" — kept entirely inside the hook, with all call sites pointing to the same function.
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

  // Refs track the latest state / props, for synchronous reads inside the unmount cleanup closure
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

  // Explicit mutate flag — distinguishes "user-initiated action triggers unmount" vs "file switch triggers unmount".
  // Design: set true at mutate entries (handleSave/Cancel/Delete various paths); reset to false when entering edit
  // (a new editing session has no explicit intent). **Not cleared in finally** — because the timing between mutate IPC
  // completion and the unmount caused by drafts:changed is uncontrollable, clearing too early would make cleanup misjudge.
  // The lock's lifecycle follows the component instance: after mutate it stays true until unmount or the next entry
  // into edit resets it
  const isMutatingRef = useRef(false);
  useEffect(() => {
    if (isEditing) isMutatingRef.current = false;
  }, [isEditing]);

  // Unified four-branch cancel logic — shared by handleCancel / unmount cleanup / Esc
  // (avoids behavior drift from implementing it separately in three places). Reads refs for the latest value, supports fire-and-forget
  const runCancelLogic = (): void => {
    const editing = editingBodyRef.current.trim();
    const persisted = draftBodyRef.current.trim();
    if (!editing && !persisted) {
      void onDelete();
      return;
    }
    if (!editing) {
      // empty + has persisted → revert (no-op on unmount, state already destroyed; sets state on handleCancel)
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

  // unmount cleanup — triggered by switching file / PR / tab. Shares runCancelLogic with the cancel button so
  // behavior is fully identical. Skipped when isMutating=true (the user has explicitly taken over via mutate, no cleanup
  // fallback needed, avoiding a race with IPC)
  useEffect(() => {
    return () => {
      if (isMutatingRef.current) return;
      if (!isEditingRef.current) return;
      runCancelLogic();
    };
    // empty deps: runs on mount/unmount; runCancelLogic reads all refs internally, no closure staleness issue
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Register the "enter edit mode" trigger into DiffView's ref map. register is a stable function reference
  // (DiffView wraps it with useCallback), draft.id doesn't change → effect only runs on mount/unmount.
  // Calling fn does not cause a React state change on the DiffView side → no re-render → no
  // unmount/mount cycle, entering edit happens exactly once
  useEffect(() => {
    registerEditTrigger?.(draft.id, () => {
      setIsEditing(true);
      setEditingBody(draftBodyRef.current);
    });
    return () => registerEditTrigger?.(draft.id, null);
  }, [draft.id, registerEditTrigger]);

  // draft.body changed externally (e.g., queue write-back) + currently not editing → sync editingBody
  useEffect(() => {
    if (!isEditing) setEditingBody(draft.body);
  }, [draft.body, isEditing]);

  // On entering edit, focus + move cursor to end
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      const el = textareaRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [isEditing]);

  // textarea's React onKeyDown runs in the bubble phase under React 18 root delegation,
  // and monaco's capture-stage keydown listener on the editor container may stopPropagation and swallow Esc
  // before the event bubbles, so textarea's onKeyDown never fires.
  // Fallback: a window-level capture listener, when textarea is focused pressing Esc runs runCancelLogic
  // (shared with the cancel button / unmount cleanup) + sets isMutatingRef=true so cleanup skips
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
    // runCancelLogic is a local fn, not in deps; the listener is removed when isEditing switches back
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  const status = draft.status;
  // posted should no longer be editable; UI hides edit/delete buttons and greys the whole thing out
  const canEdit = status !== 'posted';

  const trimmedEditing = editingBody.trim();
  // Comment cannot be empty: no characters after trim disallows saving. Submit button disabled + button title explains
  const canSave = trimmedEditing.length > 0;

  const handleSave = async (): Promise<void> => {
    if (saving) return;
    if (!canSave) return; // defensive: double safeguard beyond the button being disabled
    if (trimmedEditing === draft.body.trim()) {
      // unchanged → fall back to read without calling IPC
      setIsEditing(false);
      return;
    }
    isMutatingRef.current = true;
    setSaving(true);
    try {
      await onSave(editingBody);
      // draft.body updates after the store event comes back, but optimistically exit edit first; feels smoother
      setIsEditing(false);
    } finally {
      setSaving(false);
    }
  };

  // Publish a single draft directly. Only pending/edited are publishable; empty body is not published either (Bitbucket rejects empty comments).
  // No confirm popup — the "publish" mental model for a single comment differs from "batch review", it's an instant action; the
  // second confirmation is enough done at the PublishReviewModal layer, the batch entry
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
      // Success → drafts-store broadcast switches status to 'posted', the component auto re-renders to show
      // the posted chip + remote id. No manual setIsEditing etc. needed, the draft prop flow pushes it back
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : String(e));
    } finally {
      setPublishing(false);
    }
  };

  // "publish" in edit mode — save the current textarea content locally first, then call publish.
  // Design motivation: the cancel button already has dirty auto-save semantics, a standalone "save" button is redundant;
  // after editing, the most natural next step is to publish, so merge into one click.
  // - Save failure (local disk write almost never fails) → still attempt publish; what the publish side reads from disk is the
  //   last successfully saved body on main, no silent-error risk to the user
  // - Publish failure (Bitbucket 4xx) → stay in edit so the user can edit body and retry, with an inline error hint
  const handlePublishFromEdit = async (): Promise<void> => {
    if (!onPublish || publishing) return;
    if (!canSave) return;
    isMutatingRef.current = true;
    setPublishError(null);
    // Persist this editing content first — onPublish reads the body from disk via the main store, so we must
    // ensure disk holds the latest version the user just edited
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
    // Cancel reuses runCancelLogic (shared with unmount cleanup). Difference: handleCancel actively
    // sets isMutatingRef=true (explicit user action), letting cleanup know the intent has been taken over
    isMutatingRef.current = true;
    // The internal dirty branch needs to await save before exiting edit, so run a separate awaited version:
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
    // body non-empty (including a draft being edited) → pop ConfirmModal for a second confirmation; empty draft deletes directly.
    // In edit mode judge by editingBody (the user may have typed a lot in the textarea unsaved before clicking delete)
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
      // Cmd/Ctrl+Enter prefers "publish" (consistent with the new primary button); falls back to save when onPublish is absent
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

  // Cancel button dynamic label: textarea has content → "stash", signaling the click won't lose content; textarea
  // completely empty → "cancel", corresponding to the "exit edit without leaving a draft" semantics (runCancelLogic then deletes
  // the truly empty draft / reverts).
  // No longer uses "dirty (editing != persisted)" as the criterion — a user entering edit and seeing existing saved content
  // without changing it still "has text", and per the user's mental model this should be stash (even if internally it's a no-op exit of edit)
  // textarea has content → stash semantics; empty → cancel semantics. The stash flag drives the button label and title
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
