import { useMemo, useState } from 'react';
import type { LocalPrStatus, StoredPullRequest } from '@meebox/shared';
import { PrItem } from './PrItem';

// 'conflict' / 'mergeable' 是按远端 merge 状态跨 localStatus 横切的筛选；'all' 不限定
type FilterKey = 'all' | LocalPrStatus | 'conflict' | 'mergeable';

interface SidebarProps {
  prs: StoredPullRequest[];
  selectedId: string | null;
  onSelect: (pr: StoredPullRequest) => void;
  width: number;
  onResize: (next: number) => void;
}

export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 720;

const FILTERS: ReadonlyArray<{ value: FilterKey; label: string }> = [
  { value: 'pending', label: '待处理' },
  { value: 'all', label: '全部' },
  { value: 'approved', label: '通过' },
  { value: 'needs_work', label: '需修改' },
  { value: 'conflict', label: '冲突' },
  { value: 'mergeable', label: '可合并' },
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
  const [filter, setFilter] = useState<FilterKey>('pending');
  // 哪些组当前折叠了。默认空集合 = 全部展开。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const counts = useMemo(() => {
    const out: Record<FilterKey, number> = {
      all: prs.length,
      pending: 0,
      approved: 0,
      needs_work: 0,
      conflict: 0,
      mergeable: 0,
    };
    for (const p of prs) {
      out[p.localStatus] += 1;
      if (p.hasConflict) out.conflict += 1;
      if (p.mergeStatus?.canMerge) out.mergeable += 1;
    }
    return out;
  }, [prs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return prs.filter((p) => {
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
