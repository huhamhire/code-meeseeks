import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalPrStatus, StoredPullRequest } from '@meebox/shared';
import { invoke } from '../../../../api';
import { formatBackendError } from '../../../../errors';

/**
 * PR list lifecycle and detail actions (domain-cohesive): list state + selection, cached reload /
 * remote refresh, approval status decisions, merge. Unaware of boot/connection (the selected
 * connection lookup is derived by App from boot; startup / focus refresh is driven by
 * useBootstrap via reloadPrs), only depends on notifyError to surface operation-level errors.
 */
export function usePullRequests({ notifyError }: { notifyError: (msg: string) => void }) {
  const { t } = useTranslation();
  const [prs, setPrs] = useState<StoredPullRequest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Merge in progress: GitHub merge can be slow (mergeable is computed asynchronously); set the button to a waiting state and prevent repeated clicks.
  const [merging, setMerging] = useState(false);

  const reloadPrs = useCallback(async (): Promise<void> => {
    const fresh = await invoke('prs:list', undefined);
    setPrs(fresh);
  }, []);

  const triggerRefresh = useCallback(async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await invoke('prs:refresh', undefined);
      await reloadPrs();
    } catch (e) {
      console.error('refresh failed', e);
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, reloadPrs]);

  // Mark PR as read: called when the user opens a PR. First optimistically clear the local unread flags (instant feedback), then persist the read watermark —
  // the next poll round won't re-mark it due to stale events. Send IPC on every selection: opening a PR is not high-frequency, and advancing the read watermark is inherently correct;
  // don't rely on the side effect of the setState updater to decide "is it unread" — the updater only runs during the render phase, so synchronously reading its side effect gets no result.
  // There are two unread flags: the `unread` dot and the `unreadMentionCount` "@me/replies to me" count chip (the two are mutually exclusive in the title slot, count takes priority).
  // Both must be optimistically zeroed — otherwise the count chip lingers until the next poll round recomputes lastReadAt before disappearing,
  // manifesting as "unread count doesn't clear after opening the PR" (aligned with the backend markPrRead persisting unread:false / unreadMentionCount:0).
  const markRead = useCallback(async (localId: string): Promise<void> => {
    setPrs((prev) =>
      prev.map((p) =>
        p.localId === localId && (p.unread || (p.unreadMentionCount ?? 0) > 0)
          ? { ...p, unread: false, unreadMentionCount: 0 }
          : p,
      ),
    );
    try {
      await invoke('prs:markRead', { localId });
    } catch (e) {
      console.error('markRead failed', e);
    }
  }, []);

  const selected = prs.find((p) => p.localId === selectedId) ?? null;

  const setSelectedPrStatus = useCallback(
    async (status: LocalPrStatus): Promise<void> => {
      if (!selected) return;
      try {
        const updated = await invoke('prs:setLocalStatus', { localId: selected.localId, status });
        if (updated) {
          setPrs((prev) => prev.map((p) => (p.localId === updated.localId ? updated : p)));
        }
      } catch (e) {
        // Remote rejection (e.g. PR already closed / merged / insufficient permissions) → local state unchanged, show a toast.
        // Refresh once as well: if the PR is already closed, the next poll round soft-deletes it and the list stays consistent
        const msg = e instanceof Error ? e.message : String(e);
        notifyError(t('app.approveActionFailed', { msg }));
        void triggerRefresh();
      }
    },
    [selected, notifyError, triggerRefresh, t],
  );

  const mergeSelectedPr = useCallback(async (): Promise<void> => {
    if (!selected || merging) return;
    const mergedId = selected.localId;
    setMerging(true);
    try {
      await invoke('prs:merge', { localId: mergedId });
    } catch (e) {
      // Merge failed (PR already merged / conflict / veto / permissions) → show a toast, local unchanged. First decode via formatBackendError
      // to i18n the AppError error code (e.g. EPR0003 "already merged" gives a friendly message), non-coded errors fall back to the original message.
      notifyError(t('app.mergeFailed', { msg: formatBackendError(e).title }));
      void triggerRefresh();
      return;
    } finally {
      setMerging(false);
    }
    // Merge succeeded: the PR has transitioned to MERGED and will leave the pending list. Deselect + refresh to make it disappear
    if (selectedId === mergedId) setSelectedId(null);
    await triggerRefresh();
  }, [selected, selectedId, triggerRefresh, notifyError, merging, t]);

  return {
    prs,
    setPrs,
    selectedId,
    setSelectedId,
    selected,
    refreshing,
    merging,
    reloadPrs,
    triggerRefresh,
    setSelectedPrStatus,
    mergeSelectedPr,
    markRead,
  };
}
