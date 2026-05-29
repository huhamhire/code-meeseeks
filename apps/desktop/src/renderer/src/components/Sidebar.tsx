import { useMemo, useState } from 'react';
import type { LocalPrStatus, StoredPullRequest } from '@pr-pilot/shared';
import { PrItem } from './PrItem';

type FilterStatus = 'all' | LocalPrStatus;

interface SidebarProps {
  prs: StoredPullRequest[];
  selectedId: string | null;
  onSelect: (pr: StoredPullRequest) => void;
}

const FILTERS: ReadonlyArray<{ value: FilterStatus; label: string }> = [
  { value: 'pending', label: '待处理' },
  { value: 'all', label: '全部' },
  { value: 'reviewed', label: '已评' },
  { value: 'skipped', label: '已跳过' },
];

export function Sidebar({ prs, selectedId, onSelect }: SidebarProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterStatus>('pending');

  const counts = useMemo(() => {
    const out: Record<FilterStatus, number> = {
      all: prs.length,
      pending: 0,
      reviewed: 0,
      skipped: 0,
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

  return (
    <aside className="sidebar">
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
        {filtered.length === 0 ? (
          <div className="sidebar-empty">没有匹配的 PR</div>
        ) : (
          filtered.map((pr) => (
            <PrItem
              key={pr.localId}
              pr={pr}
              selected={selectedId === pr.localId}
              onClick={() => onSelect(pr)}
            />
          ))
        )}
      </div>
    </aside>
  );
}
