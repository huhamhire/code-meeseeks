import { describe, expect, it } from 'vitest';
import { pullRequestHeadRefspec } from '@meebox/shared';

describe('pullRequestHeadRefspec', () => {
  it('builds the PR head ref refspec per platform (exact number, not a wildcard)', () => {
    expect(pullRequestHeadRefspec('github', '108')).toBe('+refs/pull/108/head:refs/pull/108/head');
    expect(pullRequestHeadRefspec('gitlab', '42')).toBe(
      '+refs/merge-requests/42/head:refs/merge-requests/42/head',
    );
    expect(pullRequestHeadRefspec('bitbucket-server', '7')).toBe(
      '+refs/pull-requests/7/from:refs/pull-requests/7/from',
    );
  });

  it('remoteId not purely numeric → null (do not build a suspicious ref)', () => {
    expect(pullRequestHeadRefspec('github', '')).toBeNull();
    expect(pullRequestHeadRefspec('github', 'abc')).toBeNull();
    expect(pullRequestHeadRefspec('github', '1; rm -rf')).toBeNull();
    expect(pullRequestHeadRefspec('github', '12/head')).toBeNull();
  });

  it('tolerates surrounding whitespace (purely numeric after trim)', () => {
    expect(pullRequestHeadRefspec('github', ' 9 ')).toBe('+refs/pull/9/head:refs/pull/9/head');
  });
});
