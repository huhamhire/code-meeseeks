import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { PrDiscoveryFilter, StoredPullRequest } from '@meebox/shared';
import { invoke, subscribe } from '../api';
import { formatBackendError } from '../errors';

/**
 * Cross-component jump intent (M4): ChatPane finding card "edit" click / PublishReviewModal anchor click / notification click on inline
 * comment → set here → PrPanel switches to Diff tab + passes through to DiffView for scroll/highlight/(optional) open edit zone, cleared once consumed.
 */
export interface PendingDiffNav {
  runId?: string;
  findingId?: string;
  anchor: { path: string; startLine: number; endLine: number };
}

export interface PrNavigation {
  /** List scope: in-progress (active) / closed (archived cold storage, lazy-loaded, read-only). */
  scope: 'active' | 'archived';
  /** GitHub discovery category (runtime filter, not persisted); shown in PR list only when the active connection supports it. */
  discoveryFilter: PrDiscoveryFilter;
  /** Currently displayed list (archived scope uses the archived list, otherwise the active list). */
  displayedPrs: StoredPullRequest[];
  /** Selected PR resolved from the currently displayed list (null when not resolvable). */
  selectedPr: StoredPullRequest | null;
  /** Archived cold storage fetch in progress (the list area shows loading based on this). */
  archivedLoading: boolean;
  /** Select a discovery category (sidebar tab / command panel) → return to "in-progress" scope and switch category. */
  selectDiscovery: (f: PrDiscoveryFilter) => void;
  /** Switch to "in-progress" scope. */
  viewActive: () => void;
  /** Switch to "closed" scope (triggers lazy load). */
  viewArchived: () => void;
  /** Open a PR of the current platform by URL (command panel "open URL"): locate locally or fetch the archive, then switch to the matching scope and select it; shows a toast on failure. */
  openPrByUrl: (url: string) => Promise<void>;
  /** Locate and select a PR (active hit switches to active + switches category if needed + marks read; otherwise treated as archived → switch to archived scope, load the archived list, then select). */
  jumpToPr: (localId: string) => Promise<void>;
  pendingDiffNav: PendingDiffNav | null;
  setPendingDiffNav: Dispatch<SetStateAction<PendingDiffNav | null>>;
  pendingTab: 'activity' | null;
  setPendingTab: Dispatch<SetStateAction<'activity' | null>>;
}

/**
 * PR navigation / scope domain: on top of {@link usePullRequests}'s list + selection, governs discovery categories, active / archived scope switching,
 * archived cold storage lazy loading, opening by URL, locate-and-jump (unified active / archived logic), and consumes navigation intent from system notification clicks
 * (`notification:activate` → jumpToPr + inline comment jumps to Diff line / summary comment opens the "activity" tab).
 *
 * Selection state / read status is owned by usePullRequests (passed in via props); this hook only handles "where to go, which scope to view".
 */
export function usePrNavigation({
  prs,
  selectedId,
  setSelectedId,
  markRead,
  notifyError,
}: {
  prs: StoredPullRequest[];
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  markRead: (localId: string) => Promise<void> | void;
  notifyError: (text: string) => void;
}): PrNavigation {
  const [discoveryFilter, setDiscoveryFilter] = useState<PrDiscoveryFilter>('review-requested');
  const [scope, setScope] = useState<'active' | 'archived'>('active');
  const [archivedPrs, setArchivedPrs] = useState<StoredPullRequest[]>([]);
  // Archived cold storage fetch in progress: the list area shows loading based on this (archives are large and may be slow; PaneLoading has a built-in 150ms delay, so the fast path doesn't flash).
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [pendingDiffNav, setPendingDiffNav] = useState<PendingDiffNav | null>(null);
  // Notification click on a summary comment → request PrPanel to switch to the "activity" conversation tab (inline comments go through pendingDiffNav).
  const [pendingTab, setPendingTab] = useState<'activity' | null>(null);

  // Lazy-load archived cold storage on entering "closed" scope (re-fetch on each entry to include newly archived PRs); don't clear on leaving, to make back-and-forth switching easy.
  useEffect(() => {
    if (scope !== 'archived') return;
    let cancelled = false;
    setArchivedLoading(true);
    void invoke('prs:listArchived', undefined)
      .then((list) => {
        if (!cancelled) setArchivedPrs(list);
      })
      .finally(() => {
        if (!cancelled) setArchivedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  // Selecting a discovery category (sidebar tab / command panel) returns to "in-progress" scope; "view closed" switches to archived scope.
  const selectDiscovery = useCallback((f: PrDiscoveryFilter) => {
    setScope('active');
    setDiscoveryFilter(f);
  }, []);
  const viewActive = useCallback(() => setScope('active'), []);
  const viewArchived = useCallback(() => setScope('archived'), []);

  // Ref to the current discovery category: lets openPrByUrl / jumpToPr read the latest value in stable callbacks, avoiding putting discoveryFilter in the deps and rebuilding frequently.
  const discoveryFilterRef = useRef(discoveryFilter);
  discoveryFilterRef.current = discoveryFilter;

  const openPrByUrl = useCallback(
    async (url: string) => {
      try {
        const res = await invoke('prs:openByUrl', { url });
        setScope(res.location);
        if (res.location === 'archived') {
          // Archived scope (already archived / newly fetched archive) needs a list reload to include the target PR.
          setArchivedPrs(await invoke('prs:listArchived', undefined));
        } else if (
          // Active PR: if the current discovery category doesn't include it, fall to a category that does, ensuring the sidebar can show and highlight it (otherwise only the detail view shows, with no list selection).
          res.discoveryFilters.length > 0 &&
          !res.discoveryFilters.includes(discoveryFilterRef.current)
        ) {
          setDiscoveryFilter(res.discoveryFilters[0]!);
        }
        setSelectedId(res.localId);
        if (res.location === 'active') void markRead(res.localId);
      } catch (e) {
        notifyError(formatBackendError(e).title);
      }
    },
    [setSelectedId, markRead, notifyError],
  );

  // Ref to the active PR list: lets notification clicks / status bar jumps read the latest value in stable callbacks, avoiding putting prs in the deps and rebuilding frequently.
  const prsRef = useRef(prs);
  prsRef.current = prs;
  // Status bar run indicator / notification click → locate the PR. During a task run the PR may already have been archived by a poll (the task isn't cancelled, still running), so when
  // it's not found in the active list it's treated as archived: switch to archived scope + reload the archived list (covers both "just archived this tick, cache doesn't have it" and "already in
  // archived scope, setScope with the same value doesn't trigger lazy load") then select. On an active hit, switch to active scope + switch to a discovery category that includes it if needed (ensuring the sidebar shows and highlights it) + mark read.
  const jumpToPr = useCallback(
    async (localId: string) => {
      const active = prsRef.current.find((p) => p.localId === localId);
      if (active) {
        setScope('active');
        if (
          active.discoveryFilters.length > 0 &&
          !active.discoveryFilters.includes(discoveryFilterRef.current)
        ) {
          setDiscoveryFilter(active.discoveryFilters[0]!);
        }
        setSelectedId(localId);
        void markRead(localId);
        return;
      }
      setScope('archived');
      setArchivedPrs(await invoke('prs:listArchived', undefined));
      setSelectedId(localId);
    },
    [markRead, setSelectedId],
  );

  // System notification click → navigation: reuse jumpToPr to select the target, then locate by type — inline comment jumps to the Diff line, summary comment
  // (mention / reply) opens the "activity" tab, new_pr only selects. Shares the same active / archived locate logic as the status bar jump.
  useEffect(() => {
    return subscribe('notification:activate', ({ localId, kind, anchor }) => {
      void jumpToPr(localId);
      if (anchor) {
        setPendingDiffNav({ anchor: { path: anchor.path, startLine: anchor.line, endLine: anchor.line } });
      } else if (kind === 'mention' || kind === 'reply') {
        setPendingTab('activity');
      }
    });
  }, [jumpToPr]);

  // The list / detail data source switches with scope: closed scope uses the archived list, otherwise the active list. The selected PR is resolved from the currently displayed list —
  // when switching to archived scope, if the previous selection was an active PR it won't resolve and the detail area falls back to an empty state, showing details again after an archived item is selected.
  const displayedPrs = scope === 'archived' ? archivedPrs : prs;
  const selectedPr = displayedPrs.find((p) => p.localId === selectedId) ?? null;

  return {
    scope,
    discoveryFilter,
    displayedPrs,
    selectedPr,
    archivedLoading,
    selectDiscovery,
    viewActive,
    viewArchived,
    openPrByUrl,
    jumpToPr,
    pendingDiffNav,
    setPendingDiffNav,
    pendingTab,
    setPendingTab,
  };
}
