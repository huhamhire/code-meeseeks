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
  it('(c) flags by branch convention when the source is a mainline branch', () => {
    expect(classifyBranchMerge({ sourceBranch: 'main', targetBranch: 'feature/x' })).toEqual({
      isBranchMerge: true,
      basis: 'branch-convention',
    });
  });

  it('is inconclusive for a feature source with no commits provided', () => {
    expect(classifyBranchMerge({ sourceBranch: 'feature/x', targetBranch: 'main' })).toEqual({
      isBranchMerge: false,
      basis: 'inconclusive',
    });
  });

  it('(b) flags by commits when every commit is a merge', () => {
    const commits = [{ parents: ['a', 'b'] }, { parents: ['c', 'd'] }];
    expect(
      classifyBranchMerge({ sourceBranch: 'feature/x', targetBranch: 'main', commits }),
    ).toEqual({
      isBranchMerge: true,
      basis: 'commits',
    });
  });

  it('(b) does not flag when there is an original (non-merge) commit', () => {
    const commits = [{ parents: ['a', 'b'] }, { parents: ['c'] }];
    expect(
      classifyBranchMerge({ sourceBranch: 'feature/x', targetBranch: 'main', commits }),
    ).toEqual({
      isBranchMerge: false,
      basis: 'commits',
    });
  });

  it('(b) does not flag an empty commit list', () => {
    expect(
      classifyBranchMerge({ sourceBranch: 'feature/x', targetBranch: 'main', commits: [] }),
    ).toEqual({ isBranchMerge: false, basis: 'commits' });
  });
});
