import type { LocalPrStatus, StoredPullRequest } from './poller-contract.js';
import type { PrDiscoveryFilter } from './platform.js';

/**
 * PR 列表筛选与检索的**纯谓词**（单一真相源）。渲染层侧栏与本地 API 的 PR 列表端点共用同一套语义，
 * 避免两处各写一份过滤逻辑而漂移。仅做无副作用的判定 / 过滤，不含 UI（计数、可见性、分组属各自表现层）。
 *
 * 二级筛选 `PrSecondaryFilter`：`'all'` 不限定；`LocalPrStatus`（本人评审决断 pending/approved/needs_work）
 * 按 `localStatus` 匹配；`'conflict'` / `'mergeable'` 是跨 localStatus 横切的远端合并态筛选。
 */
export type PrSecondaryFilter = 'all' | LocalPrStatus | 'conflict' | 'mergeable';

/** 二级筛选全集（与 {@link PrSecondaryFilter} 同步；本地 API 的分类标签据此列出）。 */
export const PR_SECONDARY_FILTERS: readonly PrSecondaryFilter[] = [
  'all',
  'pending',
  'approved',
  'needs_work',
  'conflict',
  'mergeable',
];

/** 一级（平台发现分类）匹配：未指定一级 = 不限定；否则按 PR 携带的 discoveryFilters 命中判定。 */
export function matchesDiscoveryFilter(
  pr: StoredPullRequest,
  primary?: PrDiscoveryFilter,
): boolean {
  return !primary || (pr.discoveryFilters?.includes(primary) ?? false);
}

/** 二级筛选匹配（状态 / 合并态）。 */
export function matchesSecondaryFilter(
  pr: StoredPullRequest,
  secondary: PrSecondaryFilter,
): boolean {
  switch (secondary) {
    case 'all':
      return true;
    case 'conflict':
      return pr.hasConflict === true;
    case 'mergeable':
      return pr.mergeStatus?.canMerge === true;
    default:
      return pr.localStatus === secondary;
  }
}

/** 检索匹配：空查询恒真；否则在 标题 / 仓库 / 作者 / 编号 拼成的串里做大小写无关子串匹配。 */
export function matchesPrQuery(pr: StoredPullRequest, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    pr.title,
    pr.repo.projectKey,
    pr.repo.repoSlug,
    pr.author.displayName,
    pr.author.name,
    pr.remoteId,
  ]
    .join(' ')
    .toLowerCase()
    .includes(q);
}

/** 筛选条件（各项可省，省略即不限定）。 */
export interface PrFilterCriteria {
  primary?: PrDiscoveryFilter;
  secondary?: PrSecondaryFilter;
  query?: string;
}

/** 按 一级 + 二级 + 检索 顺序过滤 PR 列表。 */
export function filterPullRequests(
  prs: StoredPullRequest[],
  criteria: PrFilterCriteria,
): StoredPullRequest[] {
  return prs.filter(
    (p) =>
      matchesDiscoveryFilter(p, criteria.primary) &&
      matchesSecondaryFilter(p, criteria.secondary ?? 'all') &&
      matchesPrQuery(p, criteria.query ?? ''),
  );
}
