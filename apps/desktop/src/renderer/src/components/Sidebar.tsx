import { useMemo, useState } from 'react';
import type { LocalPrStatus, StoredPullRequest } from '@pr-pilot/shared';
import { PrItem } from './PrItem';

type FilterStatus = 'all' | LocalPrStatus;

interface SidebarProps {
  prs: StoredPullRequest[];
  selectedId: string | null;
  onSelect: (pr: StoredPullRequest) => void;
  width: number;
  onResize: (next: number) => void;
}

export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 720;

const FILTERS: ReadonlyArray<{ value: FilterStatus; label: string }> = [
  { value: 'pending', label: '待处理' },
  { value: 'all', label: '全部' },
  { value: 'reviewed', label: '已评' },
  { value: 'skipped', label: '已跳过' },
  { value: 'ignored', label: '已忽略' },
];

interface PrGroup {
  key: string;
  items: StoredPullRequest[];
}

export function Sidebar({ prs, selectedId, onSelect, width, onResize }: SidebarProps) {
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
  const [filter, setFilter] = useState<FilterStatus>('pending');
  // 哪些组当前折叠了。默认空集合 = 全部展开。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const counts = useMemo(() => {
    const out: Record<FilterStatus, number> = {
      all: prs.length,
      pending: 0,
      reviewed: 0,
      skipped: 0,
      ignored: 0,
    };
    for (const p of prs) out[p.localStatus]++;
    return out;
  }, [prs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return prs.filter((p) => {
      if (filter !== 'all' && p.localStatus !== filter) return false;
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
  }, [prs, query, filter]);

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
        title="拖动调整侧栏宽度"
        aria-label="resize sidebar"
      />
      <div className="sidebar-toolbar">
        <input
          type="text"
          className="sidebar-search"
          placeholder="搜索标题 / 仓库 / 作者 / ID"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="sidebar-toolbar sidebar-filters">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            className={`btn btn-sm ${filter === f.value ? 'btn-primary' : ''}`}
            onClick={() => setFilter(f.value)}
            type="button"
          >
            {f.label}
            <span className="count-pill">{counts[f.value]}</span>
          </button>
        ))}
      </div>
      <div className="sidebar-list">
        {groups.length === 0 ? (
          <div className="sidebar-empty">没有匹配的 PR</div>
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
