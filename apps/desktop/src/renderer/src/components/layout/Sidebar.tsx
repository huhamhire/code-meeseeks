import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  matchesDiscoveryFilter,
  matchesPrQuery,
  matchesSecondaryFilter,
  type AgentRecommendationVerdict,
  type PrDiscoveryFilter,
  type PrSecondaryFilter,
  type StoredPullRequest,
} from '@meebox/shared';
import { invoke, subscribe } from '../../api';
import { useChatRunStore } from '../../stores/chat-run-store';
import { HistoryIcon, PaneLoading } from '../common';
import { PrItem } from '../features/pr';

// Secondary filter key reuses @meebox/shared's PrSecondaryFilter (same source as the local API):
// 'conflict' / 'mergeable' cut across localStatus by remote merge status; 'all' is unrestricted.
export type FilterKey = PrSecondaryFilter;

/** PR list scope: active (in-progress, subdivided by discovery category + status) / archived (cold-storage archive, flat read-only browsing). */
export type SidebarScope = 'active' | 'archived';

interface SidebarProps {
  prs: StoredPullRequest[];
  /**
   * Active-scope PRs (always passed, independent of the current scope): feeds the unread-dot
   * computation for primary discovery-category tabs—even in the "archived" view, the tabs still
   * reflect unread of active categories. Falls back to prs when omitted.
   */
  activePrs?: StoredPullRequest[];
  selectedId: string | null;
  onSelect: (pr: StoredPullRequest) => void;
  width: number;
  onResize: (next: number) => void;
  /** Discovery categories supported by the active connection (from capabilities); when empty / undefined, the category tab row is not rendered. */
  availableFilters?: readonly PrDiscoveryFilter[];
  /** Currently selected discovery category. */
  discoveryFilter?: PrDiscoveryFilter;
  onDiscoveryFilterChange?: (filter: PrDiscoveryFilter) => void;
  /** Status filter (pending / all / conflict / mergeable etc.), held by App so the command palette can drive it too. */
  statusFilter: FilterKey;
  onStatusFilterChange: (filter: FilterKey) => void;
  /** Current scope: in-progress / archived. */
  scope: SidebarScope;
  /** Switch back to "in-progress" (platforms without discovery categories use a single anchor; with categories, clicking a tab goes back via onDiscoveryFilterChange). */
  onViewActive: () => void;
  /** Switch to the "archived" scope. */
  onViewArchived: () => void;
  /** List data loading (e.g. archive cold-storage lazy load): the list area shows a loading placeholder in place of the "no PR" empty state. */
  loading?: boolean;
  /** Whether the active connection supports the needs_work ("needs work") review state: decides whether the "pending" status filter is kept under categories other than "review requested". */
  supportsNeedsWork?: boolean;
}

export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 720;

/** Discovery-category tab i18n keys; which categories actually show is decided by the active connection's capabilities.discoveryFilters. */
const DISCOVERY_LABEL_KEYS: Record<PrDiscoveryFilter, string> = {
  'review-requested': 'sidebar.discoveryReviewRequested',
  created: 'sidebar.discoveryCreated',
  assigned: 'sidebar.discoveryAssigned',
  mentioned: 'sidebar.discoveryMentioned',
};

export const FILTERS: ReadonlyArray<{ value: FilterKey; labelKey: string }> = [
  { value: 'pending', labelKey: 'sidebar.filterPending' },
  { value: 'all', labelKey: 'sidebar.filterAll' },
  { value: 'approved', labelKey: 'sidebar.filterApproved' },
  { value: 'needs_work', labelKey: 'sidebar.filterNeedsWork' },
  { value: 'conflict', labelKey: 'sidebar.filterConflict' },
  { value: 'mergeable', labelKey: 'sidebar.filterMergeable' },
];

// Reviewer-decision filters (approved/needs work): with discovery-category tabs they only make sense
// under "review requested", being always empty under other tabs, so they are hidden; without
// discovery categories, all six status filters are still shown.
export const DECISION_STATUS_FILTERS: ReadonlySet<FilterKey> = new Set(['approved', 'needs_work']);

interface PrGroup {
  key: string;
  items: StoredPullRequest[];
}

export function Sidebar({
  prs,
  activePrs,
  selectedId,
  onSelect,
  width,
  onResize,
  availableFilters,
  discoveryFilter,
  onDiscoveryFilterChange,
  statusFilter,
  onStatusFilterChange,
  scope,
  onViewActive,
  onViewArchived,
  loading = false,
  supportsNeedsWork = false,
}: SidebarProps) {
  const { t } = useTranslation();
  // Archived scope: flat browsing (no discovery categories, no status split, forced "all"); the in-progress scope keeps the original subdivided behavior.
  const isArchived = scope === 'archived';
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX;
      const next = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startWidth + dx));
      onResize(next);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const [query, setQuery] = useState('');
  // Clear the search box after switching PR type (discovery-category tab / in-progress⇄archived scope), to avoid the previous type's filter carrying over into the new type.
  useEffect(() => {
    setQuery('');
  }, [discoveryFilter, scope]);
  // Status filter is now held by App (controlled): the command palette's "category filter" can drive it too; collapsing the sidebar doesn't lose the selection.
  const filter = statusFilter;
  const setFilter = onStatusFilterChange;
  // Which groups are currently collapsed. Default empty set = all expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Review recommendation ledger (per localId, manual / AutoPilot treated alike), used for the ★ badge in the PR list;
  // batch-refetched when prs changes.
  const [reviewVerdicts, setReviewVerdicts] = useState<
    Record<string, AgentRecommendationVerdict>
  >({});

  // Data source for the "executing" indicator: PRs with a running / queued run in the run queue (active + waiting),
  // **unioned with** PRs that have an orchestrating Agent running (agentPrs, including the pure-thinking phase with no active tool run)—filling the gap where list items lack an executing marker during the agent's thinking state.
  const { active, waiting, agentPrs } = useChatRunStore();
  const executingPrIds = useMemo(
    () => new Set([...active.map((r) => r.prLocalId), ...waiting.map((r) => r.prLocalId), ...agentPrs]),
    [active, waiting, agentPrs],
  );

  // Status-filter visibility refines with discovery category (localStatus = the user's own reviewer decision):
  // - No discovery categories (single "review requested" platform): all six shown.
  // - With discovery categories: reviewer-decision filters (approved / needs work) always hidden. "pending" is always
  //   meaningful under "review requested"; under the other categories (created / assigned / mentioned) it is kept only
  //   when the platform supports needs_work (GitHub / Bitbucket, which can express the "needs work" semantics),
  //   while on GitLab (binary approval, no needs_work) "pending" is meaningless and hidden, leaving only all / conflict / mergeable.
  const hasDiscoveryTabs = Boolean(availableFilters && availableFilters.length > 0);
  const visibleFilters = useMemo(() => {
    if (!hasDiscoveryTabs) return FILTERS;
    const reviewerContext = discoveryFilter === 'review-requested';
    return FILTERS.filter((f) => {
      if (DECISION_STATUS_FILTERS.has(f.value)) return false;
      if (f.value === 'pending' && !reviewerContext && !supportsNeedsWork) return false;
      return true;
    });
  }, [hasDiscoveryTabs, discoveryFilter, supportsNeedsWork]);
  // When the currently selected status filter is not visible under this category, fall back to the first visible item (review requested → pending; others → all), to avoid filtering by an invisible filter.
  useEffect(() => {
    if (!visibleFilters.some((f) => f.value === filter)) {
      setFilter(visibleFilters[0]?.value ?? 'all');
    }
  }, [visibleFilters, filter, setFilter]);

  // AutoPilot badge: batch-fetch the ledger recommendations for the current PRs (refresh when prs changes; the ledger is reflected after the next poll updates prs).
  useEffect(() => {
    const localIds = prs.map((p) => p.localId);
    if (localIds.length === 0) {
      setReviewVerdicts({});
      return;
    }
    let cancelled = false;
    void invoke('agent:autopilotLedgers', { localIds }).then((v) => {
      if (!cancelled) setReviewVerdicts(v);
    });
    return () => {
      cancelled = true;
    };
  }, [prs]);

  // Clearing a PR's execution history also clears its AutoPilot ledger → immediately clear that PR's review-recommendation ★ (no need to wait for the next poll to refetch).
  useEffect(() => {
    const unsub = subscribe('agent:reviewStatusCleared', (ev) => {
      setReviewVerdicts((prev) => {
        if (!(ev.prLocalId in prev)) return prev;
        const next = { ...prev };
        delete next[ev.prLocalId];
        return next;
      });
    });
    return unsub;
  }, []);

  // Review completion (both manual / AutoPilot write the ledger via recordReviewSummaryMessage + broadcast agent:conversationChanged) →
  // immediately refetch that PR's review recommendation, so the ★ appears in the PR list at once, without waiting for the next poll to refresh prs.
  useEffect(() => {
    const unsub = subscribe('agent:conversationChanged', (ev) => {
      void invoke('agent:autopilotLedgers', { localIds: [ev.prLocalId] }).then((v) => {
        const verdict = v[ev.prLocalId];
        if (verdict === undefined) return;
        setReviewVerdicts((prev) =>
          prev[ev.prLocalId] === verdict ? prev : { ...prev, [ev.prLocalId]: verdict },
        );
      });
    });
    return unsub;
  }, []);

  // GitHub discovery categories: filter locally by the discoveryFilters marked on each PR (the poller has already fetched and cached all four categories),
  // so switching tabs is purely local, instantaneous, zero remote requests. For non-GitHub (discoveryFilter unset), use the full set.
  const scopedPrs = useMemo(
    () => prs.filter((p) => matchesDiscoveryFilter(p, !isArchived ? discoveryFilter : undefined)),
    [prs, discoveryFilter, isArchived],
  );

  // Unread dots are always based on **active** PRs (falls back to prs): even in the "archived" view, primary tabs still reflect unread of active categories.
  const unreadSourcePrs = activePrs ?? prs;
  // Whether each primary discovery category has any unread PR → add an unread dot after the tab text, hinting the category has new items to handle.
  const unreadFilters = useMemo(() => {
    const s = new Set<PrDiscoveryFilter>();
    for (const p of unreadSourcePrs) {
      if (!p.unread) continue;
      for (const f of p.discoveryFilters ?? []) s.add(f);
    }
    return s;
  }, [unreadSourcePrs]);
  // Single "in-progress" anchor for platforms without discovery categories: mark the dot if any active PR is unread.
  const anyUnread = useMemo(() => unreadSourcePrs.some((p) => p.unread), [unreadSourcePrs]);

  const counts = useMemo(() => {
    const out: Record<FilterKey, number> = {
      all: scopedPrs.length,
      pending: 0,
      approved: 0,
      needs_work: 0,
      conflict: 0,
      mergeable: 0,
    };
    for (const p of scopedPrs) {
      out[p.localStatus] += 1;
      if (p.hasConflict) out.conflict += 1;
      if (p.mergeStatus?.canMerge) out.mergeable += 1;
    }
    // Under "created", "pending" folds in conflicting PRs (the author needs to follow up); recompute via the same-source predicate to avoid double-counting with the conflict count.
    if (!isArchived && discoveryFilter === 'created') {
      out.pending = scopedPrs.filter((p) => matchesSecondaryFilter(p, 'pending', 'created')).length;
    }
    return out;
  }, [scopedPrs, isArchived, discoveryFilter]);

  const filtered = useMemo(() => {
    // Archived scope forces "all" (no status filter applied); in-progress scope filters by the current status. Filter / search
    // semantics reuse @meebox/shared's pure predicates (same source as the local API), passing in the primary discovery category to enable category-specific semantic refinement.
    const effFilter: FilterKey = isArchived ? 'all' : filter;
    const effPrimary = !isArchived ? discoveryFilter : undefined;
    return scopedPrs.filter(
      (p) => matchesSecondaryFilter(p, effFilter, effPrimary) && matchesPrQuery(p, query),
    );
  }, [scopedPrs, query, filter, isArchived, discoveryFilter]);

  const groups = useMemo<PrGroup[]>(() => {
    const m = new Map<string, StoredPullRequest[]>();
    for (const pr of filtered) {
      const key = `${pr.repo.projectKey}/${pr.repo.repoSlug}`;
      const list = m.get(key);
      if (list) list.push(pr);
      else m.set(key, [pr]);
    }
    // Groups sorted alphabetically by repo path; PRs within a group sorted by remote updatedAt descending (most recently modified on top)
    return Array.from(m.entries())
      .map(([key, items]) => ({
        key,
        items: items.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [filtered]);

  // Force expand while searching (otherwise the user won't see matching PRs inside collapsed groups)
  const searching = query.trim().length > 0;

  const toggleGroup = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <aside className="sidebar" style={{ width: `${width}px` }}>
      <div
        className="sidebar-resize-handle"
        onMouseDown={startResize}
        title={t('sidebar.resizeTitle')}
        aria-label="resize sidebar"
      />
      {/* Scope row (always present): left group = in-progress (subdivided by discovery category, or a single anchor for platforms without categories), right group = archived auxiliary toggle.
          The left group always has an anchor, keeping "archived" a secondary item to the side and not misread as the only category. */}
      <div className="sidebar-toolbar sidebar-scope" role="tablist" aria-label={t('sidebar.discoveryTablistAria')}>
        <div className="sidebar-scope-primary">
          {hasDiscoveryTabs && availableFilters && onDiscoveryFilterChange ? (
            availableFilters.map((f) => (
              <button
                key={f}
                role="tab"
                aria-selected={!isArchived && discoveryFilter === f}
                className={`sidebar-discovery-tab ${!isArchived && discoveryFilter === f ? 'is-active' : ''}`}
                onClick={() => onDiscoveryFilterChange(f)}
                type="button"
              >
                {t(DISCOVERY_LABEL_KEYS[f])}
                {unreadFilters.has(f) && (
                  <span className="sidebar-discovery-tab-dot" aria-label="unread" />
                )}
              </button>
            ))
          ) : (
            <button
              role="tab"
              aria-selected={!isArchived}
              className={`sidebar-discovery-tab ${!isArchived ? 'is-active' : ''}`}
              onClick={onViewActive}
              type="button"
            >
              {t('sidebar.scopeActive')}
              {anyUnread && <span className="sidebar-discovery-tab-dot" aria-label="unread" />}
            </button>
          )}
        </div>
        {/* Not a tab: standalone icon button (switch to archived scope), toggle semantics via aria-pressed */}
        <button
          type="button"
          aria-pressed={isArchived}
          className={`sidebar-scope-history ${isArchived ? 'is-active' : ''}`}
          onClick={onViewArchived}
          title={t('sidebar.scopeArchived')}
          aria-label={t('sidebar.scopeArchived')}
        >
          <HistoryIcon size={14} />
        </button>
      </div>
      <div className="sidebar-toolbar">
        <input
          type="text"
          className="sidebar-search"
          placeholder={t('sidebar.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {!isArchived && (
      <div className="sidebar-toolbar sidebar-filters">
        {visibleFilters.map((f) => (
          <button
            key={f.value}
            className={`btn btn-sm ${filter === f.value ? 'btn-primary' : ''}`}
            onClick={() => setFilter(f.value)}
            type="button"
          >
            {t(f.labelKey)}
            <span
              className={`count-pill ${
                f.value === 'mergeable' && counts.mergeable > 0 ? 'count-pill-mergeable' : ''
              }`}
            >
              {counts[f.value]}
            </span>
          </button>
        ))}
      </div>
      )}
      <div className="sidebar-list">
        {loading ? (
          <PaneLoading label={t('sidebar.loading')} />
        ) : groups.length === 0 ? (
          <div className="sidebar-empty">
            {t(isArchived ? 'sidebar.archivedEmpty' : 'sidebar.empty')}
          </div>
        ) : (
          groups.map((g) => {
            const expanded = searching || !collapsed.has(g.key);
            return (
              <div key={g.key} className="pr-group">
                <button
                  type="button"
                  className={`pr-group-header ${expanded ? 'expanded' : 'collapsed'}`}
                  onClick={() => toggleGroup(g.key)}
                  aria-expanded={expanded}
                >
                  <span className="pr-group-chevron" aria-hidden="true">
                    ▶
                  </span>
                  <span className="pr-group-key">{g.key}</span>
                  <span className="count-pill">{g.items.length}</span>
                </button>
                {expanded && (
                  <div className="pr-group-items">
                    {g.items.map((pr) => (
                      <PrItem
                        key={pr.localId}
                        pr={pr}
                        selected={selectedId === pr.localId}
                        onClick={() => onSelect(pr)}
                        reviewVerdict={reviewVerdicts[pr.localId] ?? null}
                        executing={executingPrIds.has(pr.localId)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
