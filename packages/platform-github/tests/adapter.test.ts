import type { PrDiscoveryFilter } from '@meebox/shared';
import { describe, expect, it } from 'vitest';
import { GitHubAdapter, normalizeGitHubApiBase } from '../src/adapter.js';

// ---- 路由式 mock fetch：按 method + URL 子串匹配，返回 JSON Response，并记录请求 ----
interface Route {
  method?: string;
  match: string;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}
interface Captured {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function makeFetch(routes: Route[], captured: Captured[]) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    captured.push({
      method,
      url: input,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    const route = routes.find(
      (r) => (r.method ?? 'GET').toUpperCase() === method && input.includes(r.match),
    );
    if (!route) {
      return new Response(JSON.stringify({ message: `no route for ${method} ${input}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
    });
  };
}

function makeAdapter(routes: Route[]): { adapter: GitHubAdapter; captured: Captured[] } {
  const captured: Captured[] = [];
  const adapter = new GitHubAdapter({
    baseUrl: 'https://api.github.com',
    token: 'tok',
    fetch: makeFetch(routes, captured),
  });
  return { adapter, captured };
}

const PULL_7 = {
  number: 7,
  title: 'Add feature',
  body: 'desc',
  state: 'open',
  draft: false,
  merged: false,
  html_url: 'https://github.com/acme/web/pull/7',
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-02T00:00:00Z',
  user: { login: 'author', id: 1, name: 'Author' },
  head: { ref: 'feature', sha: 'headsha', repo: { name: 'web', owner: { login: 'acme' } } },
  base: { ref: 'main', sha: 'basesha', repo: { name: 'web', owner: { login: 'acme' } } },
  requested_reviewers: [{ login: 'pending', id: 2 }],
  mergeable: true,
  mergeable_state: 'clean',
};

describe('GitHubAdapter capabilities', () => {
  it('declares partial merge veto fidelity + no optimistic lock + rate-limited discovery', () => {
    const { adapter } = makeAdapter([]);
    const caps = adapter.capabilities();
    expect(caps.reviewStatuses).toEqual(['approved', 'needsWork', 'unapproved']);
    expect(caps.commentOptimisticLock).toBe(false);
    expect(caps.mergeVetoFidelity).toBe('partial');
    expect(caps.discoveryRateLimited).toBe(true);
  });
});

describe('GitHubAdapter ping', () => {
  it('caches current user from /user and reports github.com', async () => {
    const { adapter } = makeAdapter([{ match: '/user', body: { login: 'me', id: 9, name: 'Me' } }]);
    const r = await adapter.ping();
    expect(r.ok).toBe(true);
    expect(r.serverVersion).toBe('github.com');
    expect(adapter.getCurrentUser()).toEqual({ name: 'me', displayName: 'Me', slug: 'me' });
  });

  it('reports GHE version from response header', async () => {
    const { adapter } = makeAdapter([
      { match: '/user', body: { login: 'me', id: 9 }, headers: { 'x-github-enterprise-version': '3.12.0' } },
    ]);
    const r = await adapter.ping();
    expect(r.serverVersion).toBe('3.12.0');
  });
});

describe('GitHubAdapter listPendingPullRequests', () => {
  it('maps search hits + PR detail + reviews into PullRequest', async () => {
    const { adapter } = makeAdapter([
      {
        match: '/search/issues',
        body: {
          items: [{ number: 7, repository_url: 'https://api.github.com/repos/acme/web', pull_request: {} }],
        },
      },
      { match: '/repos/acme/web/pulls/7/reviews', body: [{ id: 1, user: { login: 'rev', id: 3 }, state: 'APPROVED', submitted_at: '2026-06-02T01:00:00Z' }] },
      { match: '/repos/acme/web/pulls/7', body: PULL_7 },
    ]);
    const prs = await adapter.listPendingPullRequests();
    expect(prs).toHaveLength(1);
    const pr = prs[0]!;
    expect(pr.remoteId).toBe('7');
    expect(pr.repo).toEqual({ projectKey: 'acme', repoSlug: 'web' });
    expect(pr.sourceRef.sha).toBe('headsha');
    expect(pr.mergeStatus.canMerge).toBe(true);
    // reviewer：已请求未评审(pending=unapproved) + 已 APPROVED 的 rev
    const byName = Object.fromEntries(pr.reviewers.map((r) => [r.name, r.status]));
    expect(byName.rev).toBe('approved');
    expect(byName.pending).toBe('unapproved');
  });

  it('默认 filter = review-requested，查询带 is:open（排除已合并/已关闭）', async () => {
    const { adapter, captured } = makeAdapter([{ match: '/search/issues', body: { items: [] } }]);
    await adapter.listPendingPullRequests();
    const q = new URL(captured[0]!.url).searchParams.get('q') ?? '';
    expect(q).toContain('is:open');
    expect(q).toContain('is:pr');
    expect(q).toContain('review-requested:@me');
  });

  it('四类发现分类映射到对应 search 限定词，均含 is:open', async () => {
    const cases: Array<[PrDiscoveryFilter, string]> = [
      ['review-requested', 'review-requested:@me'],
      ['created', 'author:@me'],
      ['assigned', 'assignee:@me'],
      ['mentioned', 'mentions:@me'],
    ];
    for (const [filter, qualifier] of cases) {
      const { adapter, captured } = makeAdapter([
        { match: '/search/issues', body: { items: [] } },
      ]);
      await adapter.listPendingPullRequests({ filter });
      const q = new URL(captured[0]!.url).searchParams.get('q') ?? '';
      expect(q).toContain(qualifier);
      expect(q).toContain('is:open'); // 已合并/已关闭 PR 不应出现在任一分类
    }
  });
});

describe('GitHubAdapter listPullRequestComments', () => {
  it('merges issue (summary) + review (inline, threaded) comments', async () => {
    const { adapter } = makeAdapter([
      { match: '/issues/7/comments', body: [{ id: 1, user: { login: 'a', id: 1 }, body: 'summary', created_at: 'c', updated_at: 'u' }] },
      {
        match: '/pulls/7/comments',
        body: [
          { id: 10, user: { login: 'b', id: 2 }, body: 'inline top', path: 'x.ts', line: 5, side: 'RIGHT', created_at: 'c', updated_at: 'u' },
          { id: 11, in_reply_to_id: 10, user: { login: 'c', id: 3 }, body: 'reply', path: 'x.ts', line: 5, side: 'RIGHT', created_at: 'c', updated_at: 'u' },
        ],
      },
    ]);
    const comments = await adapter.listPullRequestComments({ projectKey: 'acme', repoSlug: 'web' }, '7');
    expect(comments).toHaveLength(2); // 1 summary + 1 inline top-level
    const summary = comments.find((c) => c.kind === 'summary')!;
    expect(summary.anchor).toBeNull();
    const inline = comments.find((c) => c.kind === 'inline')!;
    expect(inline.anchor).toEqual({ path: 'x.ts', line: 5, side: 'new', lineType: 'added' });
    expect(inline.replies).toHaveLength(1);
    expect(inline.replies[0]!.body).toBe('reply');
  });
});

describe('GitHubAdapter listPullRequestCommits', () => {
  it('reverses GitHub oldest-first into newest-first', async () => {
    const { adapter } = makeAdapter([
      {
        match: '/pulls/7/commits',
        body: [
          { sha: 'aaa', commit: { message: 'first', author: { name: 'A', date: 'c1' }, committer: { name: 'A', date: 'c1' } }, parents: [], author: null, committer: null },
          { sha: 'bbb', commit: { message: 'second', author: { name: 'B', date: 'c2' }, committer: { name: 'B', date: 'c2' } }, parents: [{ sha: 'aaa' }], author: null, committer: null },
        ],
      },
    ]);
    const commits = await adapter.listPullRequestCommits({ projectKey: 'acme', repoSlug: 'web' }, '7');
    expect(commits.map((c) => c.sha)).toEqual(['bbb', 'aaa']);
    expect(commits[0]!.abbreviatedSha).toBe('bbb');
  });
});

describe('GitHubAdapter publishInlineComment', () => {
  it('posts with commit_id = head sha and mapped side', async () => {
    const { adapter, captured } = makeAdapter([
      { match: '/repos/acme/web/pulls/7', body: PULL_7 },
      { method: 'POST', match: '/pulls/7/comments', body: { id: 99, user: { login: 'me', id: 1 }, body: 'hi', path: 'x.ts', line: 3, side: 'RIGHT', created_at: 'c', updated_at: 'u' } },
    ]);
    const created = await adapter.publishInlineComment(
      { projectKey: 'acme', repoSlug: 'web' },
      '7',
      { path: 'x.ts', line: 3, side: 'new', lineType: 'added' },
      'hi',
    );
    expect(created.remoteId).toBe('99');
    const post = captured.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ commit_id: 'headsha', path: 'x.ts', line: 3, side: 'RIGHT' });
  });
});

describe('GitHubAdapter setPullRequestReviewStatus', () => {
  it('approve → POST reviews event=APPROVE', async () => {
    const { adapter, captured } = makeAdapter([
      { method: 'POST', match: '/pulls/7/reviews', body: { id: 1 } },
    ]);
    await adapter.setPullRequestReviewStatus({ projectKey: 'acme', repoSlug: 'web' }, '7', 'approved');
    const post = captured.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ event: 'APPROVE' });
  });

  it('needsWork → POST reviews event=REQUEST_CHANGES with body', async () => {
    const { adapter, captured } = makeAdapter([
      { method: 'POST', match: '/pulls/7/reviews', body: { id: 1 } },
    ]);
    await adapter.setPullRequestReviewStatus({ projectKey: 'acme', repoSlug: 'web' }, '7', 'needsWork');
    const post = captured.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ event: 'REQUEST_CHANGES' });
  });
});

describe('GitHubAdapter mergeStatus mapping', () => {
  it('dirty mergeable_state → conflicted + cannot merge', async () => {
    const dirty = { ...PULL_7, mergeable: false, mergeable_state: 'dirty' };
    const { adapter } = makeAdapter([
      { match: '/search/issues', body: { items: [{ number: 7, repository_url: 'https://api.github.com/repos/acme/web', pull_request: {} }] } },
      { match: '/repos/acme/web/pulls/7/reviews', body: [] },
      { match: '/repos/acme/web/pulls/7', body: dirty },
    ]);
    const pr = (await adapter.listPendingPullRequests())[0]!;
    expect(pr.mergeStatus.conflicted).toBe(true);
    expect(pr.mergeStatus.canMerge).toBe(false);
    expect(pr.hasConflict).toBe(true);
  });
});

describe('GitHubAdapter getAttachment（PAT 仅发可信域）', () => {
  it('外部 host 直接 null 且不发起请求；githubusercontent 资产带 PAT 代理', async () => {
    const { adapter, captured } = makeAdapter([
      { match: 'evil.example.com', body: '' },
      { match: 'githubusercontent.com', body: '' },
    ]);
    const external = await adapter.getAttachment('https://evil.example.com/leak.png');
    const asset = await adapter.getAttachment('https://avatars.githubusercontent.com/u/1?v=4');
    // 外部 host：不代理、不请求（无 captured）、返回 null → 渲染层退回原生 <img>
    expect(external).toBeNull();
    expect(captured.some((c) => c.url.includes('evil.example.com'))).toBe(false);
    // 可信资产域：代理并带 PAT
    expect(asset).not.toBeNull();
    const gh = captured.find((c) => c.url.includes('githubusercontent.com'))!;
    expect(gh.headers.Authorization).toMatch(/^Bearer /);
  });
});

describe('normalizeGitHubApiBase', () => {
  it('github.com SaaS：官方 API host 原样保留（不破坏公共 SaaS 对接）', () => {
    expect(normalizeGitHubApiBase('https://api.github.com')).toBe('https://api.github.com');
  });

  it('github.com web host → 官方 API host', () => {
    expect(normalizeGitHubApiBase('https://github.com')).toBe('https://api.github.com');
    expect(normalizeGitHubApiBase('https://www.github.com/')).toBe('https://api.github.com');
  });

  it('GHE 实例根自动补 /api/v3', () => {
    expect(normalizeGitHubApiBase('https://ghe.example.com')).toBe('https://ghe.example.com/api/v3');
    expect(normalizeGitHubApiBase('https://ghe.example.com/')).toBe(
      'https://ghe.example.com/api/v3',
    );
  });

  it('GHE 已带 /api/v3 原样（含尾斜杠归一）', () => {
    expect(normalizeGitHubApiBase('https://ghe.example.com/api/v3/')).toBe(
      'https://ghe.example.com/api/v3',
    );
  });
});
