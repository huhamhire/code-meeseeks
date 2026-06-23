import { describe, expect, it } from 'vitest';
import { pullRequestHeadRefspec } from '@meebox/shared';

describe('pullRequestHeadRefspec', () => {
  it('按平台构造 PR 头引用 refspec（精确编号，非通配）', () => {
    expect(pullRequestHeadRefspec('github', '108')).toBe('+refs/pull/108/head:refs/pull/108/head');
    expect(pullRequestHeadRefspec('gitlab', '42')).toBe(
      '+refs/merge-requests/42/head:refs/merge-requests/42/head',
    );
    expect(pullRequestHeadRefspec('bitbucket-server', '7')).toBe(
      '+refs/pull-requests/7/from:refs/pull-requests/7/from',
    );
  });

  it('remoteId 非纯数字 → null（不构造可疑 ref）', () => {
    expect(pullRequestHeadRefspec('github', '')).toBeNull();
    expect(pullRequestHeadRefspec('github', 'abc')).toBeNull();
    expect(pullRequestHeadRefspec('github', '1; rm -rf')).toBeNull();
    expect(pullRequestHeadRefspec('github', '12/head')).toBeNull();
  });

  it('两端空白容错（trim 后纯数字）', () => {
    expect(pullRequestHeadRefspec('github', ' 9 ')).toBe('+refs/pull/9/head:refs/pull/9/head');
  });
});
