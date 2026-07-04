import { useCallback, useEffect, useRef } from 'react';
import type { StoredPullRequest } from '@meebox/shared';

export interface DraftAutoEdit {
  registerEditTrigger: (draftId: string, fn: (() => void) | null) => void;
  triggerAutoEdit: (draftId: string) => void;
}

/**
 * autoEdit trigger table: draft.id → "enter edit mode" fn. Used by two sources:
 *   1. ChatPane → after App.pendingDiffNav navigation completes, the target draft auto-enters edit
 *   2. after a line hover '+' creates a manual draft, immediately enter edit (a new draft with empty body must be typeable)
 *
 * Uses a ref-based fn rather than a state token. The token approach once caused a bug: user cancels → auto save → drafts store
 * changes → DiffView re-renders → DraftZone unmount/mount → the new instance sees the props token still non-undefined
 * and calls setIsEditing(true) again → user perceives "cancel didn't take effect". A ref-fn call is a pure side effect, triggering no re-render.
 */
export function useDraftAutoEdit(pr: StoredPullRequest): DraftAutoEdit {
  const editTriggerFnsRef = useRef<Map<string, () => void>>(new Map());
  // pending trigger fallback: when triggerAutoEdit is called, the DraftZone has not yet mounted + registered
  // (typical scenario: trigger immediately after a hover '+' creation, while the drafts store updates asynchronously). When fn is not in the map,
  // add the id to pending; on registerEditTrigger, if it finds itself pending, fire immediately
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

  // PR switch clears all trigger fn references + pending (the new PR's DraftZone will re-register)
  useEffect(() => {
    editTriggerFnsRef.current.clear();
    pendingTriggersRef.current.clear();
  }, [pr.localId]);

  return { registerEditTrigger, triggerAutoEdit };
}
