import { describe, expect, it } from 'vitest';
import type { StoredPullRequest } from '../src/poller-contract.js';
import {
  PR_SECONDARY_FILTERS,
  filterPullRequests,
  matchesDiscoveryFilter,
  matchesPrQuery,
  matchesSecondaryFilter,
} from '../src/pr-filter.js';

/** Minimal StoredPullRequest builder: only fills the fields the predicates use, skipping the rest via double-cast. */
function mkPr(over: Partial<StoredPullRequest>): StoredPullRequest {
  return {
    title: 'Fix login bug',
    repo: { projectKey: 'PROJ', repoSlug: 'web-app' },
    author: { displayName: 'Alice Zhang', name: 'alice' },
    remoteId: '42',
    localStatus: 'pending',
    hasConflict: false,
    mergeStatus: { canMerge: false, conflicted: false, vetoes: [] },
    discoveryFilters: ['review-requested'],
    ...over,
  } as unknown as StoredPullRequest;
}

describe('matchesDiscoveryFilter', () => {
  it('no primary = unfiltered, always true', () => {
    expect(matchesDiscoveryFilter(mkPr({ discoveryFilters: [] }), undefined)).toBe(true);
  });
  it('matches discoveryFilters → true', () => {
    expect(
      matchesDiscoveryFilter(mkPr({ discoveryFilters: ['review-requested', 'created'] }), 'created'),
    ).toBe(true);
  });
  it('no match → false', () => {
    expect(matchesDiscoveryFilter(mkPr({ discoveryFilters: ['review-requested'] }), 'assigned')).toBe(
      false,
    );
  });
  it('PR has no discoveryFilters and a primary is given → false', () => {
    expect(matchesDiscoveryFilter(mkPr({ discoveryFilters: undefined }), 'review-requested')).toBe(
      false,
    );
  });
});

describe('matchesSecondaryFilter', () => {
  it("'all' is always true", () => {
    expect(matchesSecondaryFilter(mkPr({ localStatus: 'needs_work' }), 'all')).toBe(true);
  });
  it('matches by localStatus', () => {
    expect(matchesSecondaryFilter(mkPr({ localStatus: 'approved' }), 'approved')).toBe(true);
    expect(matchesSecondaryFilter(mkPr({ localStatus: 'pending' }), 'approved')).toBe(false);
  });
  it("'conflict' checks hasConflict", () => {
    expect(matchesSecondaryFilter(mkPr({ hasConflict: true }), 'conflict')).toBe(true);
    expect(matchesSecondaryFilter(mkPr({ hasConflict: false }), 'conflict')).toBe(false);
  });
  it("'mergeable' checks mergeStatus.canMerge", () => {
    expect(
      matchesSecondaryFilter(
        mkPr({ mergeStatus: { canMerge: true, conflicted: false, vetoes: [] } }),
        'mergeable',
      ),
    ).toBe(true);
    expect(
      matchesSecondaryFilter(
        mkPr({ mergeStatus: { canMerge: false, conflicted: false, vetoes: [] } }),
        'mergeable',
      ),
    ).toBe(false);
  });
  it("'pending' defaults to localStatus, excludes conflicts", () => {
    expect(matchesSecondaryFilter(mkPr({ localStatus: 'pending' }), 'pending')).toBe(true);
    expect(
      matchesSecondaryFilter(mkPr({ localStatus: 'approved', hasConflict: true }), 'pending'),
    ).toBe(false);
  });
  it("'pending' under 'created' includes conflicted PRs (author must follow up)", () => {
    // review already approved but has a conflict → counted as pending under created
    expect(
      matchesSecondaryFilter(
        mkPr({ localStatus: 'approved', hasConflict: true }),
        'pending',
        'created',
      ),
    ).toBe(true);
    // no conflict and not pending → still not counted
    expect(
      matchesSecondaryFilter(
        mkPr({ localStatus: 'approved', hasConflict: false }),
        'pending',
        'created',
      ),
    ).toBe(false);
    // localStatus pending is counted on its own
    expect(
      matchesSecondaryFilter(
        mkPr({ localStatus: 'pending', hasConflict: false }),
        'pending',
        'created',
      ),
    ).toBe(true);
  });
});

describe('matchesPrQuery', () => {
  const pr = mkPr({
    title: 'Fix login bug',
    repo: { projectKey: 'PROJ', repoSlug: 'web-app' },
    author: { displayName: 'Alice Zhang', name: 'alice' } as StoredPullRequest['author'],
    remoteId: '42',
  });
  it('empty query is always true', () => {
    expect(matchesPrQuery(pr, '')).toBe(true);
    expect(matchesPrQuery(pr, '   ')).toBe(true);
  });
  it('case-insensitive match on title / repo / author / id', () => {
    expect(matchesPrQuery(pr, 'LOGIN')).toBe(true); // title
    expect(matchesPrQuery(pr, 'web-app')).toBe(true); // repoSlug
    expect(matchesPrQuery(pr, 'proj')).toBe(true); // projectKey
    expect(matchesPrQuery(pr, 'alice')).toBe(true); // author.name
    expect(matchesPrQuery(pr, 'Alice Zhang')).toBe(true); // author.displayName
    expect(matchesPrQuery(pr, '42')).toBe(true); // remoteId
  });
  it('no match → false', () => {
    expect(matchesPrQuery(pr, 'nonexistent')).toBe(false);
  });
});

describe('filterPullRequests', () => {
  const prs = [
    mkPr({
      remoteId: '1',
      title: 'alpha',
      localStatus: 'pending',
      discoveryFilters: ['review-requested'],
    }),
    mkPr({
      remoteId: '2',
      title: 'beta',
      localStatus: 'approved',
      discoveryFilters: ['created'],
    }),
    mkPr({
      remoteId: '3',
      title: 'gamma',
      localStatus: 'approved',
      discoveryFilters: ['review-requested'],
      hasConflict: true,
    }),
  ];

  it('empty criteria returns all', () => {
    expect(filterPullRequests(prs, {})).toHaveLength(3);
  });
  it('primary filter', () => {
    const out = filterPullRequests(prs, { primary: 'review-requested' });
    expect(out.map((p) => p.remoteId)).toEqual(['1', '3']);
  });
  it('primary + secondary AND', () => {
    const out = filterPullRequests(prs, { primary: 'review-requested', secondary: 'approved' });
    expect(out.map((p) => p.remoteId)).toEqual(['3']);
  });
  it('secondary + query AND', () => {
    const out = filterPullRequests(prs, { secondary: 'approved', query: 'beta' });
    expect(out.map((p) => p.remoteId)).toEqual(['2']);
  });
  it('conflict cross-cutting filter', () => {
    expect(filterPullRequests(prs, { secondary: 'conflict' }).map((p) => p.remoteId)).toEqual(['3']);
  });
  it("'created' + 'pending' includes conflicted approved PRs", () => {
    const createdPrs = [
      mkPr({ remoteId: '10', localStatus: 'pending', discoveryFilters: ['created'] }),
      mkPr({
        remoteId: '11',
        localStatus: 'approved',
        hasConflict: true,
        discoveryFilters: ['created'],
      }),
      mkPr({ remoteId: '12', localStatus: 'approved', discoveryFilters: ['created'] }),
    ];
    const out = filterPullRequests(createdPrs, { primary: 'created', secondary: 'pending' });
    expect(out.map((p) => p.remoteId)).toEqual(['10', '11']);
  });
});

describe('PR_SECONDARY_FILTERS', () => {
  it('contains all secondary filter keys', () => {
    expect(PR_SECONDARY_FILTERS).toEqual([
      'all',
      'pending',
      'approved',
      'needs_work',
      'conflict',
      'mergeable',
    ]);
  });
});
