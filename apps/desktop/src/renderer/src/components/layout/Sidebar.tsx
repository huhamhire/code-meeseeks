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

// 二级筛选键复用 @meebox/shared 的 PrSecondaryFilter（与本地 API 同源）：
// 'conflict' / 'mergeable' 按远端 merge 状态跨 localStatus 横切；'all' 不限定。
export type FilterKey = PrSecondaryFilter;

/** PR 列表范围：进行中（活跃，按发现分类 + 状态细分）/ 已关闭（归档冷存储，扁平只读浏览）。 */
export type SidebarScope = 'active' | 'archived';

interface SidebarProps {
  prs: StoredPullRequest[];
  selectedId: string | null;
  onSelect: (pr: StoredPullRequest) => void;
  width: number;
  onResize: (next: number) => void;
  /** 活动连接支持的发现分类（来自 capabilities）；为空 / undefined 时不渲染分类标签行。 */
  availableFilters?: readonly PrDiscoveryFilter[];
  /** 当前选中的发现分类。 */
  discoveryFilter?: PrDiscoveryFilter;
  onDiscoveryFilterChange?: (filter: PrDiscoveryFilter) => void;
  /** 状态筛选（待处理 / 全部 / 冲突 / 可合并等），由 App 持有以便命令面板亦可驱动。 */
  statusFilter: FilterKey;
  onStatusFilterChange: (filter: FilterKey) => void;
  /** 当前范围：进行中 / 已关闭。 */
  scope: SidebarScope;
  /** 切回「进行中」（无发现分类的平台用单一锚点；有发现分类则点 tab 经 onDiscoveryFilterChange 切回）。 */
  onViewActive: () => void;
  /** 切到「已关闭」（归档）范围。 */
  onViewArchived: () => void;
  /** 列表数据加载中（如归档冷存储懒加载）：列表区显示 loading 占位，替代「无 PR」空态。 */
  loading?: boolean;
  /** 活动连接是否支持 needs_work（「需修改」）评审态：决定非「待我评审」分类下是否保留「待处理」状态筛选。 */
  supportsNeedsWork?: boolean;
}

export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 720;

/** 发现分类标签 i18n key；实际展示哪几类由活动连接的 capabilities.discoveryFilters 决定。 */
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

// reviewer 决断类（通过/需修改）：有发现分类标签时只对「待我评审」有意义，其余标签下恒空，
// 故隐藏；无发现分类的场景仍展示全部六项状态筛选。
export const DECISION_STATUS_FILTERS: ReadonlySet<FilterKey> = new Set(['approved', 'needs_work']);

interface PrGroup {
  key: string;
  items: StoredPullRequest[];
}

export function Sidebar({
  prs,
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
  // 已关闭范围：扁平浏览（不分发现分类、不分状态、强制「全部」）；进行中范围维持原细分行为。
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
  // 切换 PR 类型（发现分类标签 / 进行中⇄已关闭范围）后清空搜索框，避免上一类型遗留的过滤条件连带到新类型。
  useEffect(() => {
    setQuery('');
  }, [discoveryFilter, scope]);
  // 状态筛选改由 App 持有（受控）：命令面板的「分类筛选」亦可驱动；折叠侧栏也不丢选择。
  const filter = statusFilter;
  const setFilter = onStatusFilterChange;
  // 哪些组当前折叠了。默认空集合 = 全部展开。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // 评审建议台账 recommendation（per localId，手动 / AutoPilot 一视同仁），PR 列表 ★ 徽标用；
  // prs 变化时批量重取。
  const [reviewVerdicts, setReviewVerdicts] = useState<
    Record<string, AgentRecommendationVerdict>
  >({});

  // 「执行中」指示数据源：运行队列里有在跑 / 排队 run 的 PR（active + waiting），**并上**有编排 Agent
  // 运行中的 PR（agentPrs，含纯思考阶段、无活跃工具 run 时）——补齐 agent 思考态下列表项缺执行中标记的空档。
  const { active, waiting, agentPrs } = useChatRunStore();
  const executingPrIds = useMemo(
    () => new Set([...active.map((r) => r.prLocalId), ...waiting.map((r) => r.prLocalId), ...agentPrs]),
    [active, waiting, agentPrs],
  );

  // 状态筛选可见性随发现分类细化（localStatus = 本人的 reviewer 决断）：
  // - 无发现分类（单一「待我评审」平台）：六项全展示。
  // - 有发现分类：reviewer 决断类（通过 / 需修改）恒隐藏。「待处理」在「待我评审」恒有意义；其余分类
  //   （我创建的 / 指派给我 / 提及我）下仅当平台支持 needs_work（GitHub / Bitbucket，可表达「需修改」语义）
  //   时保留，GitLab（二元审批、无 needs_work）下「待处理」无意义、隐藏，只留 全部 / 冲突 / 可合并。
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
  // 当前选中的状态筛选在本分类下不可见时，回落到首个可见项（待我评审 → 待处理；其余 → 全部），避免按不可见筛选过滤。
  useEffect(() => {
    if (!visibleFilters.some((f) => f.value === filter)) {
      setFilter(visibleFilters[0]?.value ?? 'all');
    }
  }, [visibleFilters, filter, setFilter]);

  // AutoPilot 徽标：批量取当前 PR 的台账建议（prs 变化时刷新；ledger 在下次 poll 更新 prs 后体现）。
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

  // 清空某 PR 执行历史会一并清掉其 AutoPilot 台账 → 即时清掉该 PR 的评审建议 ★（不必等下个 poll 重取）。
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

  // 评审完成（手动 / AutoPilot 都经 recordReviewSummaryMessage 写台账 + 广播 agent:conversationChanged）→
  // 即时重取该 PR 的评审建议，让 ★ 立刻出现在 PR 列表，不必等下个 poll 刷新 prs 才体现。
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

  // GitHub 发现分类：按 PR 上的 discoveryFilters 标记本地过滤（poller 已把四类都抓回来缓存），
  // 切标签纯本地、瞬时、零远端请求。非 GitHub（discoveryFilter 未设）时用全量。
  const scopedPrs = useMemo(
    () => prs.filter((p) => matchesDiscoveryFilter(p, !isArchived ? discoveryFilter : undefined)),
    [prs, discoveryFilter, isArchived],
  );

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
    return out;
  }, [scopedPrs]);

  const filtered = useMemo(() => {
    // 已关闭范围强制「全部」（不应用状态筛选）；进行中范围按当前状态筛选。过滤 / 检索语义复用
    // @meebox/shared 纯谓词（与本地 API 同源）。
    const effFilter: FilterKey = isArchived ? 'all' : filter;
    return scopedPrs.filter(
      (p) => matchesSecondaryFilter(p, effFilter) && matchesPrQuery(p, query),
    );
  }, [scopedPrs, query, filter, isArchived]);

  const groups = useMemo<PrGroup[]>(() => {
    const m = new Map<string, StoredPullRequest[]>();
    for (const pr of filtered) {
      const key = `${pr.repo.projectKey}/${pr.repo.repoSlug}`;
      const list = m.get(key);
      if (list) list.push(pr);
      else m.set(key, [pr]);
    }
    // 组按 repo 路径字母序；组内 PR 按远端 updatedAt 倒序（最新修改在上）
    return Array.from(m.entries())
      .map(([key, items]) => ({
        key,
        items: items.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [filtered]);

  // 搜索时强制展开（否则用户在折叠组里看不到匹配的 PR）
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
      {/* 范围行（常驻）：左组 = 进行中（发现分类细分，或无分类平台的单一锚点）、右组 = 已关闭辅助切换。
          左组始终有锚点，使「已关闭」恒为旁侧的次要项、不致被误读为唯一分类。 */}
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
            </button>
          )}
        </div>
        {/* 非 tab：独立图标按钮（切换到已关闭范围），toggle 语义用 aria-pressed */}
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
