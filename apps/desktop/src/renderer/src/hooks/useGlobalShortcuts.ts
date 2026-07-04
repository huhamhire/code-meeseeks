import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { invoke } from '../api';
import { chatRunStore } from '../stores/chat-run-store';

/**
 * Window-level global shortcuts (VS Code style), all attached to a single `keydown` listener here:
 * - **F5**: run auto review on the currently selected PR (same logic as the command palette: only triggers when there
 *   is a selected PR, it's engageable, and it's not already running — reentrancy guard).
 * - **DevTools**: mac ⌥⌘I / otherwise Ctrl+Shift+I (with Shift/Alt, distinguished from the single-modifier B/J below).
 * - **View closed**: mac ⌘⇧H (avoiding the system "Hide App" ⌘H) / otherwise Ctrl+H (browser history convention).
 * - **Layout toggles**: Ctrl/Cmd+B toggles the PR list (left sidebar), Ctrl/Cmd+J toggles the chat panel (right);
 *   single modifier, excluding Shift/Alt (avoiding the Cmd+Shift+P command palette).
 *
 * `selectedId` / `canEngage` are read live via ref, so the listener rebuilds only with platform and a few stable callbacks, not resubscribing frequently as the selected PR changes.
 */
export function useGlobalShortcuts({
  platform,
  selectedId,
  canEngage,
  viewArchived,
  setSidebarCollapsed,
  setChatCollapsed,
}: {
  platform: string | undefined;
  selectedId: string | null;
  canEngage: boolean;
  viewArchived: () => void;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  setChatCollapsed: Dispatch<SetStateAction<boolean>>;
}): void {
  // Refs for the selected PR / engageable state: let the stable listener read live values, avoiding a resubscribe on every PR switch.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const canEngageRef = useRef(canEngage);
  canEngageRef.current = canEngage;

  useEffect(() => {
    const isMac = platform === 'darwin';
    const onKey = (e: KeyboardEvent): void => {
      const k = e.key.toLowerCase();
      // F5: run auto review on the currently selected PR (only triggers when there is a selected PR, it's engageable, and it's not already running — reentrancy guard)
      if (k === 'f5') {
        const id = selectedIdRef.current;
        if (id && canEngageRef.current && !chatRunStore.getSnapshot().agentPrs.includes(id)) {
          e.preventDefault();
          void invoke('agent:run', { localId: id });
        }
        return;
      }
      // DevTools: mac ⌥⌘I / otherwise Ctrl+Shift+I (with Shift/Alt, distinguished from the single-modifier B/J below)
      if (k === 'i') {
        const devtools = isMac
          ? e.metaKey && e.altKey && !e.shiftKey && !e.ctrlKey
          : e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
        if (devtools) {
          e.preventDefault();
          void invoke('app:openDevTools', undefined);
        }
        return;
      }
      // View closed (history): mac ⌘⇧H (avoiding the system "Hide App" ⌘H) / otherwise Ctrl+H (browser history convention)
      if (k === 'h') {
        const wantArchived = isMac
          ? e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey
          : e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
        if (wantArchived) {
          e.preventDefault();
          viewArchived();
        }
        return;
      }
      // Single-modifier layout toggles: Ctrl/Cmd+B (PR list), Ctrl/Cmd+J (chat panel)
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || e.shiftKey || e.altKey) return;
      if (k === 'b') {
        e.preventDefault();
        setSidebarCollapsed((c) => !c);
      } else if (k === 'j') {
        e.preventDefault();
        setChatCollapsed((c) => !c);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [platform, viewArchived, setSidebarCollapsed, setChatCollapsed]);
}
