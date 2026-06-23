import { describe, expect, it } from 'vitest';
import { classifyBranchMerge, isMainlineBranch } from '../src/branch-merge.js';

describe('isMainlineBranch', () => {
  it('recognizes long-lived / integration branches', () => {
    for (const b of [
      'main',
      'master',
      'develop',
      'dev',
      'trunk',
      'release/1.2',
      'hotfix/x',
      'MAIN',
    ]) {
      expect(isMainlineBranch(b)).toBe(true);
    }
  });
  it('treats feature / topic branches as non-mainline', () => {
    for (const b of ['feature/x', 'fix/bug', 'chore/deps', 'jdoe/wip']) {
      expect(isMainlineBranch(b)).toBe(false);
    }
  });
});

describe('classifyBranchMerge', () => {
  it('does not flag by branch name alone — a mainline source with no commits is inconclusive', () => {
    expect(classifyBranchMerge({ sourceBranch: 'main', targetBranch: 'feature/x' })).toEqual({
      isBranchMerge: false,
      basis: 'inconclusive',
      sourceMainline: true,
    });
  });

  it('is inconclusive for a feature source with no commits provided', () => {
    expect(classifyBranchMerge({ sourceBranch: 'feature/x', targetBranch: 'main' })).toEqual({
      isBranchMerge: false,
      basis: 'inconclusive',
      sourceMainline: false,
    });
  });

  it('flags by commits when every commit is a merge', () => {
    const commits = [{ parents: ['a', 'b'] }, { parents: ['c', 'd'] }];
    expect(
      classifyBranchMerge({ sourceBranch: 'feature/x', targetBranch: 'main', commits }),
    ).toEqual({
      isBranchMerge: true,
      basis: 'commits',
      sourceMainline: false,
    });
  });

  it('does not flag a mainline source that carries original (non-merge) commits', () => {
    // 复现误判修复：源为 master/dev 的 fork 原创 PR——提交含非 merge → 不是分支合并。
    const commits = [{ parents: ['a', 'b'] }, { parents: ['c'] }];
    expect(classifyBranchMerge({ sourceBranch: 'master', targetBranch: 'master', commits })).toEqual(
      { isBranchMerge: false, basis: 'commits', sourceMainline: true },
    );
  });

  it('flags a mainline source whose commits are all merges', () => {
    const commits = [{ parents: ['a', 'b'] }];
    expect(classifyBranchMerge({ sourceBranch: 'main', targetBranch: 'dev', commits })).toEqual({
      isBranchMerge: true,
      basis: 'commits',
      sourceMainline: true,
    });
  });

  it('does not flag when there is an original (non-merge) commit', () => {
    const commits = [{ parents: ['a', 'b'] }, { parents: ['c'] }];
    expect(
      classifyBranchMerge({ sourceBranch: 'feature/x', targetBranch: 'main', commits }),
    ).toEqual({
      isBranchMerge: false,
      basis: 'commits',
      sourceMainline: false,
    });
  });

  it('does not flag an empty commit list', () => {
    expect(
      classifyBranchMerge({ sourceBranch: 'feature/x', targetBranch: 'main', commits: [] }),
    ).toEqual({ isBranchMerge: false, basis: 'commits', sourceMainline: false });
  });
});
