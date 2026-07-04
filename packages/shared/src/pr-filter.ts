import type { LocalPrStatus, StoredPullRequest } from './poller-contract.js';
import type { PrDiscoveryFilter } from './platform.js';

/**
 * **Pure predicates** for PR list filtering and search (single source of truth). The renderer sidebar
 * and the local API's PR list endpoint share the same semantics, avoiding two divergent filter logics.
 * Only side-effect-free judgment / filtering, no UI (count, visibility, grouping belong to each presentation layer).
 *
 * Secondary filter `PrSecondaryFilter`: `'all'` no restriction; `LocalPrStatus` (own review verdict pending/approved/needs_work)
 * matches by `localStatus`; `'conflict'` / `'mergeable'` are remote merge-state filters cutting across localStatus.
 */
export type PrSecondaryFilter = 'all' | LocalPrStatus | 'conflict' | 'mergeable';

/** Full set of secondary filters (synced with {@link PrSecondaryFilter}; the local API lists its category labels from this). */
export const PR_SECONDARY_FILTERS: readonly PrSecondaryFilter[] = [
  'all',
  'pending',
  'approved',
  'needs_work',
  'conflict',
  'mergeable',
];

/** Primary (platform discovery category) match: no primary specified = no restriction; otherwise judged by the discoveryFilters carried by the PR. */
export function matchesDiscoveryFilter(
  pr: StoredPullRequest,
  primary?: PrDiscoveryFilter,
): boolean {
  return !primary || (pr.discoveryFilters?.includes(primary) ?? false);
}

/**
 * Secondary filter match (status / merge state). `primary` is the current primary discovery category (nullable), used for
 * category-related semantic refinement: under "created by me" (`created`), "pending" = needs author follow-up —— besides own
 * review verdict pending, it also merges in PRs with merge conflicts (the author must resolve conflicts to proceed, even if the review passed).
 */
export function matchesSecondaryFilter(
  pr: StoredPullRequest,
  secondary: PrSecondaryFilter,
  primary?: PrDiscoveryFilter,
): boolean {
  switch (secondary) {
    case 'all':
      return true;
    case 'conflict':
      return pr.hasConflict === true;
    case 'mergeable':
      return pr.mergeStatus?.canMerge === true;
    case 'pending':
      if (primary === 'created') return pr.localStatus === 'pending' || pr.hasConflict === true;
      return pr.localStatus === 'pending';
    default:
      return pr.localStatus === secondary;
  }
}

/** Search match: empty query always true; otherwise a case-insensitive substring match over the string joined from title / repo / author / number. */
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

/** Filter criteria (each item optional; omitting means no restriction). */
export interface PrFilterCriteria {
  primary?: PrDiscoveryFilter;
  secondary?: PrSecondaryFilter;
  query?: string;
}

/** Filter the PR list in primary + secondary + search order. */
export function filterPullRequests(
  prs: StoredPullRequest[],
  criteria: PrFilterCriteria,
): StoredPullRequest[] {
  return prs.filter(
    (p) =>
      matchesDiscoveryFilter(p, criteria.primary) &&
      matchesSecondaryFilter(p, criteria.secondary ?? 'all', criteria.primary) &&
      matchesPrQuery(p, criteria.query ?? ''),
  );
}
