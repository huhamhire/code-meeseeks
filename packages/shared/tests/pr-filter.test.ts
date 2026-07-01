import { describe, expect, it } from 'vitest';
import type { StoredPullRequest } from '../src/poller-contract.js';
import {
  PR_SECONDARY_FILTERS,
  filterPullRequests,
  matchesDiscoveryFilter,
  matchesPrQuery,
  matchesSecondaryFilter,
} from '../src/pr-filter.js';

/** 最小 StoredPullRequest 构造：只填谓词用到的字段，其余以 double-cast 略过。 */
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
  it('无一级 = 不限定，恒真', () => {
    expect(matchesDiscoveryFilter(mkPr({ discoveryFilters: [] }), undefined)).toBe(true);
  });
  it('命中 discoveryFilters 为真', () => {
    expect(
      matchesDiscoveryFilter(mkPr({ discoveryFilters: ['review-requested', 'created'] }), 'created'),
    ).toBe(true);
  });
  it('未命中为假', () => {
    expect(matchesDiscoveryFilter(mkPr({ discoveryFilters: ['review-requested'] }), 'assigned')).toBe(
      false,
    );
  });
  it('PR 无 discoveryFilters 且指定了一级 → 假', () => {
    expect(matchesDiscoveryFilter(mkPr({ discoveryFilters: undefined }), 'review-requested')).toBe(
      false,
    );
  });
});

describe('matchesSecondaryFilter', () => {
  it("'all' 恒真", () => {
    expect(matchesSecondaryFilter(mkPr({ localStatus: 'needs_work' }), 'all')).toBe(true);
  });
  it('按 localStatus 匹配', () => {
    expect(matchesSecondaryFilter(mkPr({ localStatus: 'approved' }), 'approved')).toBe(true);
    expect(matchesSecondaryFilter(mkPr({ localStatus: 'pending' }), 'approved')).toBe(false);
  });
  it("'conflict' 看 hasConflict", () => {
    expect(matchesSecondaryFilter(mkPr({ hasConflict: true }), 'conflict')).toBe(true);
    expect(matchesSecondaryFilter(mkPr({ hasConflict: false }), 'conflict')).toBe(false);
  });
  it("'mergeable' 看 mergeStatus.canMerge", () => {
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
});

describe('matchesPrQuery', () => {
  const pr = mkPr({
    title: 'Fix login bug',
    repo: { projectKey: 'PROJ', repoSlug: 'web-app' },
    author: { displayName: 'Alice Zhang', name: 'alice' } as StoredPullRequest['author'],
    remoteId: '42',
  });
  it('空查询恒真', () => {
    expect(matchesPrQuery(pr, '')).toBe(true);
    expect(matchesPrQuery(pr, '   ')).toBe(true);
  });
  it('大小写无关匹配标题 / 仓库 / 作者 / 编号', () => {
    expect(matchesPrQuery(pr, 'LOGIN')).toBe(true); // 标题
    expect(matchesPrQuery(pr, 'web-app')).toBe(true); // repoSlug
    expect(matchesPrQuery(pr, 'proj')).toBe(true); // projectKey
    expect(matchesPrQuery(pr, 'alice')).toBe(true); // author.name
    expect(matchesPrQuery(pr, 'Alice Zhang')).toBe(true); // author.displayName
    expect(matchesPrQuery(pr, '42')).toBe(true); // remoteId
  });
  it('未命中为假', () => {
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

  it('空条件返回全部', () => {
    expect(filterPullRequests(prs, {})).toHaveLength(3);
  });
  it('一级过滤', () => {
    const out = filterPullRequests(prs, { primary: 'review-requested' });
    expect(out.map((p) => p.remoteId)).toEqual(['1', '3']);
  });
  it('一级 + 二级 AND', () => {
    const out = filterPullRequests(prs, { primary: 'review-requested', secondary: 'approved' });
    expect(out.map((p) => p.remoteId)).toEqual(['3']);
  });
  it('二级 + 检索 AND', () => {
    const out = filterPullRequests(prs, { secondary: 'approved', query: 'beta' });
    expect(out.map((p) => p.remoteId)).toEqual(['2']);
  });
  it('conflict 横切筛选', () => {
    expect(filterPullRequests(prs, { secondary: 'conflict' }).map((p) => p.remoteId)).toEqual(['3']);
  });
});

describe('PR_SECONDARY_FILTERS', () => {
  it('含全部二级筛选键', () => {
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
