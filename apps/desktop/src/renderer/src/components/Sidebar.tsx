import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentRecommendationVerdict,
  LocalPrStatus,
  PrDiscoveryFilter,
  StoredPullRequest,
} from '@meebox/shared';
import { invoke } from '../api';
import { useChatRunStore } from '../stores/chat-run-store';
import { PrItem } from './PrItem';

// 'conflict' / 'mergeable' 是按远端 merge 状态跨 localStatus 横切的筛选；'all' 不限定
type FilterKey = 'all' | LocalPrStatus | 'conflict' | 'mergeable';

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

const FILTERS: ReadonlyArray<{ value: FilterKey; labelKey: string }> = [
  { value: 'pending', labelKey: 'sidebar.filterPending' },
  { value: 'all', labelKey: 'sidebar.filterAll' },
  { value: 'approved', labelKey: 'sidebar.filterApproved' },
  { value: 'needs_work', labelKey: 'sidebar.filterNeedsWork' },
  { value: 'conflict', labelKey: 'sidebar.filterConflict' },
  { value: 'mergeable', labelKey: 'sidebar.filterMergeable' },
];

// reviewer 决断类（通过/需修改）：有发现分类标签时只对「待我评审」有意义，其余标签下恒空，
// 故隐藏；无发现分类的场景仍展示全部六项状态筛选。
const DECISION_STATUS_FILTERS: ReadonlySet<FilterKey> = new Set(['approved', 'needs_work']);

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
}: SidebarProps) {
  const { t } = useTranslation();
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
  const [filter, setFilter] = useState<FilterKey>('pending');
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

  // 有发现分类标签时（GitHub / Bitbucket 均含「我创建的」），reviewer 决断类（通过/需修改）
  // 只对「待我评审」有意义、其余标签下恒空，故精简隐藏；无分类的场景保持全部六项。
  const hasDiscoveryTabs = Boolean(availableFilters && availableFilters.length > 0);
  const visibleFilters = useMemo(
    () => (hasDiscoveryTabs ? FILTERS.filter((f) => !DECISION_STATUS_FILTERS.has(f.value)) : FILTERS),
    [hasDiscoveryTabs],
  );
  // 进入精简模式时若当前选中的是被隐藏的决断类，回落到「待处理」，避免按不可见筛选过滤。
  useEffect(() => {
    if (hasDiscoveryTabs && DECISION_STATUS_FILTERS.has(filter)) setFilter('pending');
  }, [hasDiscoveryTabs, filter]);

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

  // GitHub 发现分类：按 PR 上的 discoveryFilters 标记本地过滤（poller 已把四类都抓回来缓存），
  // 切标签纯本地、瞬时、零远端请求。非 GitHub（discoveryFilter 未设）时用全量。
  const scopedPrs = useMemo(
    () =>
      discoveryFilter ? prs.filter((p) => p.discoveryFilters?.includes(discoveryFilter)) : prs,
    [prs, discoveryFilter],
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
    const q = query.trim().toLowerCase();
    return scopedPrs.filter((p) => {
      if (filter === 'conflict') {
        if (!p.hasConflict) return false;
      } else if (filter === 'mergeable') {
        if (!p.mergeStatus?.canMerge) return false;
      } else if (filter !== 'all' && p.localStatus !== filter) {
        return false;
      }
      if (!q) return true;
      const hay = [
        p.title,
        p.repo.projectKey,
        p.repo.repoSlug,
        p.author.displayName,
        p.author.name,
        p.remoteId,
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [scopedPrs, query, filter]);

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
      {hasDiscoveryTabs && availableFilters && onDiscoveryFilterChange && (
        <div className="sidebar-toolbar sidebar-discovery" role="tablist" aria-label={t('sidebar.discoveryTablistAria')}>
          {availableFilters.map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={discoveryFilter === f}
              className={`sidebar-discovery-tab ${discoveryFilter === f ? 'is-active' : ''}`}
              onClick={() => onDiscoveryFilterChange(f)}
              type="button"
            >
              {t(DISCOVERY_LABEL_KEYS[f])}
            </button>
          ))}
        </div>
      )}
      <div className="sidebar-toolbar">
        <input
          type="text"
          className="sidebar-search"
          placeholder={t('sidebar.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
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
      <div className="sidebar-list">
        {groups.length === 0 ? (
          <div className="sidebar-empty">{t('sidebar.empty')}</div>
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
