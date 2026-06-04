import { describe, expect, it } from 'vitest';
import { BitbucketServerAdapter } from '../src/adapter.js';
import type { FetchLike } from '../src/client.js';
import { BBClientError } from '../src/client.js';

type RouteHandler = (url: URL) => unknown;

function mockFetch(
  routes: Record<string, RouteHandler>,
  status = 200,
  extraHeaders: Record<string, string> = {},
): FetchLike {
  return async (input) => {
    const url = new URL(input);
    const handler = routes[url.pathname];
    if (!handler) {
      return new Response(JSON.stringify({ errors: [{ message: 'no route' }] }), {
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'application/json' },
      });
    }
    const body = handler(url);
    return new Response(JSON.stringify(body), {
      status,
      statusText: 'OK',
      headers: { 'content-type': 'application/json', ...extraHeaders },
    });
  };
}

function makeAdapter(fetchFn: FetchLike): BitbucketServerAdapter {
  return new BitbucketServerAdapter({
    baseUrl: 'https://bb.example.com',
    token: 'pat',
    fetch: fetchFn,
  });
}

const samplePR = {
  id: 1022,
  version: 5,
  title: 'feat 发布搜索和AI优化',
  description: '',
  state: 'OPEN' as const,
  open: true,
  closed: false,
  draft: false,
  createdDate: Date.parse('2026-05-28T01:00:00Z'),
  updatedDate: Date.parse('2026-05-28T09:30:43Z'),
  fromRef: {
    id: 'refs/heads/dev',
    displayId: 'dev',
    latestCommit: 'abc123',
    type: 'BRANCH' as const,
    repository: { slug: 'fx-help', name: 'fx-help', project: { key: 'FX', name: 'FX' } },
  },
  toRef: {
    id: 'refs/heads/master',
    displayId: 'master',
    latestCommit: 'def456',
    type: 'BRANCH' as const,
    repository: { slug: 'fx-help', name: 'fx-help', project: { key: 'FX', name: 'FX' } },
  },
  author: {
    user: {
      name: 'musk.chen',
      displayName: 'Musk.Chen-高晨',
      active: true,
      slug: 'musk.chen',
    },
    role: 'AUTHOR' as const,
    approved: false,
  },
  reviewers: [
    {
      user: {
        name: 'reviewer1',
        displayName: 'Reviewer One',
        active: true,
        slug: 'reviewer1',
      },
      role: 'REVIEWER' as const,
      approved: true,
    },
  ],
  links: {
    self: [{ href: 'https://bb.example.com/projects/FX/repos/fx-help/pull-requests/1022' }],
  },
};

describe('BitbucketServerAdapter.ping', () => {
  it('returns ok=true when version >= 7.0', async () => {
    const adapter = makeAdapter(
      mockFetch({
        '/rest/api/1.0/application-properties': () => ({
          version: '7.17.10',
          buildNumber: '7017010',
          displayName: 'Bitbucket',
        }),
      }),
    );
    const r = await adapter.ping();
    expect(r.ok).toBe(true);
    expect(r.serverVersion).toBe('7.17.10');
    expect(r.reason).toBeUndefined();
  });

  it('returns ok=false with reason for version < 7.0', async () => {
    const adapter = makeAdapter(
      mockFetch({
        '/rest/api/1.0/application-properties': () => ({
          version: '6.10.0',
          buildNumber: '6010000',
          displayName: 'Bitbucket',
        }),
      }),
    );
    const r = await adapter.ping();
    expect(r.ok).toBe(false);
    expect(r.serverVersion).toBe('6.10.0');
    expect(r.reason).toMatch(/6\.10\.0/);
  });

  it('treats malformed version as zero (ok=false)', async () => {
    const adapter = makeAdapter(
      mockFetch({
        '/rest/api/1.0/application-properties': () => ({
          version: 'nonsense',
          buildNumber: '0',
          displayName: 'Bitbucket',
        }),
      }),
    );
    const r = await adapter.ping();
    expect(r.ok).toBe(false);
  });
});

describe('BitbucketServerAdapter.getCloneUrl (default PAT)', () => {
  it('embeds <username>:<PAT> after ping caches current user', async () => {
    const adapter = makeAdapter(
      mockFetch(
        {
          '/rest/api/1.0/application-properties': () => ({
            version: '7.17.10',
            buildNumber: '7017010',
            displayName: 'Bitbucket',
          }),
          '/rest/api/1.0/users/kyle': () => ({
            name: 'kyle',
            displayName: 'Kyle Smith',
            active: true,
            slug: 'kyle',
          }),
        },
        200,
        { 'x-ausername': 'kyle' },
      ),
    );
    await adapter.ping();
    const url = await adapter.getCloneUrl({ projectKey: 'FX', repoSlug: 'fx-help' });
    expect(url).toBe('https://kyle:pat@bb.example.com/scm/FX/fx-help.git');
  });

  it('throws when ping has not populated cachedUser', async () => {
    const adapter = makeAdapter(mockFetch({}));
    await expect(
      adapter.getCloneUrl({ projectKey: 'FX', repoSlug: 'fx-help' }),
    ).rejects.toThrow(/current user unknown/);
  });
});

describe('BitbucketServerAdapter.getCloneUrl with cloneProtocol="ssh"', () => {
  it('returns scp-like SSH URL using hostname (no credentials, no port)', async () => {
    const adapter = new BitbucketServerAdapter({
      baseUrl: 'https://bb.example.com',
      token: 'pat',
      fetch: mockFetch({}),
      cloneProtocol: 'ssh',
    });
    const url = await adapter.getCloneUrl({ projectKey: 'FX', repoSlug: 'fx-help' });
    expect(url).toBe('git@bb.example.com:FX/fx-help.git');
  });

  it('drops baseUrl port from SSH URL (端口由 ssh config 负责)', async () => {
    const adapter = new BitbucketServerAdapter({
      baseUrl: 'https://bb.example.com:8443',
      token: 'pat',
      fetch: mockFetch({}),
      cloneProtocol: 'ssh',
    });
    const url = await adapter.getCloneUrl({ projectKey: 'FX', repoSlug: 'fx-help' });
    expect(url).toBe('git@bb.example.com:FX/fx-help.git');
  });
});

describe('BitbucketServerAdapter whoami / getCurrentUser', () => {
  it('returns null before ping is called', () => {
    const adapter = makeAdapter(mockFetch({}));
    expect(adapter.getCurrentUser()).toBeNull();
  });

  it('reads X-AUSERNAME from headers then fetches /users/{slug} for displayName', async () => {
    const adapter = makeAdapter(
      mockFetch(
        {
          '/rest/api/1.0/application-properties': () => ({
            version: '7.17.10',
            buildNumber: '7017010',
            displayName: 'Bitbucket',
          }),
          '/rest/api/1.0/users/kyle': () => ({
            name: 'kyle',
            displayName: 'Kyle Smith',
            active: true,
            slug: 'kyle',
          }),
        },
        200,
        { 'x-ausername': 'kyle' },
      ),
    );
    const r = await adapter.ping();
    expect(r.user).toEqual({ name: 'kyle', displayName: 'Kyle Smith', slug: 'kyle' });
    expect(adapter.getCurrentUser()).toEqual({ name: 'kyle', displayName: 'Kyle Smith', slug: 'kyle' });
  });

  it('falls back to slug as displayName when /users/{slug} 404s', async () => {
    const adapter = makeAdapter(
      mockFetch(
        {
          '/rest/api/1.0/application-properties': () => ({
            version: '7.17.10',
            buildNumber: '7017010',
            displayName: 'Bitbucket',
          }),
          // no /users/kyle handler → 404 from mockFetch default
        },
        200,
        { 'x-ausername': 'kyle' },
      ),
    );
    const r = await adapter.ping();
    expect(r.user).toEqual({ name: 'kyle', displayName: 'kyle', slug: 'kyle' });
  });

  it('skips user fetch when X-AUSERNAME header is absent', async () => {
    const adapter = makeAdapter(
      mockFetch({
        '/rest/api/1.0/application-properties': () => ({
          version: '7.17.10',
          buildNumber: '7017010',
          displayName: 'Bitbucket',
        }),
      }),
    );
    const r = await adapter.ping();
    expect(r.user).toBeUndefined();
    expect(adapter.getCurrentUser()).toBeNull();
  });
});

describe('BitbucketServerAdapter.listPendingPullRequests', () => {
  it('maps BB Server PR fields to the unified shape', async () => {
    const adapter = makeAdapter(
      mockFetch({
        '/rest/api/1.0/dashboard/pull-requests': () => ({
          size: 1,
          limit: 50,
          isLastPage: true,
          start: 0,
          values: [samplePR],
        }),
        '/rest/api/1.0/projects/FX/repos/fx-help/pull-requests/1022/merge': () => ({
          canMerge: true,
          conflicted: false,
          outcome: 'CLEAN',
        }),
      }),
    );
    const prs = await adapter.listPendingPullRequests();
    expect(prs).toHaveLength(1);
    expect(prs[0]).toEqual({
      remoteId: '1022',
      title: 'feat 发布搜索和AI优化',
      description: '',
      author: { name: 'musk.chen', displayName: 'Musk.Chen-高晨', slug: 'musk.chen' },
      state: 'open',
      draft: false,
      sourceRef: { displayId: 'dev', sha: 'abc123' },
      targetRef: { displayId: 'master', sha: 'def456' },
      repo: { projectKey: 'FX', repoSlug: 'fx-help' },
      url: 'https://bb.example.com/projects/FX/repos/fx-help/pull-requests/1022',
      createdAt: new Date(Date.parse('2026-05-28T01:00:00Z')).toISOString(),
      updatedAt: new Date(Date.parse('2026-05-28T09:30:43Z')).toISOString(),
      reviewers: [
        { name: 'reviewer1', displayName: 'Reviewer One', slug: 'reviewer1', status: 'approved' },
      ],
      mergeStatus: { canMerge: true, conflicted: false, vetoes: [] },
      hasConflict: false,
    });
  });

  it('maps /merge vetoes into mergeStatus (canMerge=false + 逐条原因)', async () => {
    const adapter = makeAdapter(
      mockFetch({
        '/rest/api/1.0/dashboard/pull-requests': () => ({
          size: 1,
          limit: 50,
          isLastPage: true,
          start: 0,
          values: [samplePR],
        }),
        '/rest/api/1.0/projects/FX/repos/fx-help/pull-requests/1022/merge': () => ({
          canMerge: false,
          conflicted: false,
          outcome: 'CLEAN',
          vetoes: [
            {
              summaryMessage: 'Not all required reviewers have approved',
              detailedMessage: 'Missing mandatory approvals from [vista]',
            },
            { summaryMessage: 'Requires successful build' },
          ],
        }),
      }),
    );
    const prs = await adapter.listPendingPullRequests();
    expect(prs[0]!.mergeStatus).toEqual({
      canMerge: false,
      conflicted: false,
      vetoes: [
        {
          summary: 'Not all required reviewers have approved',
          detail: 'Missing mandatory approvals from [vista]',
        },
        { summary: 'Requires successful build', detail: undefined },
      ],
    });
    // 无冲突但有 veto：hasConflict 仍为 false，阻塞原因只在 mergeStatus 里
    expect(prs[0]!.hasConflict).toBe(false);
  });

  it('maps conflicted PR with hasConflict=true', async () => {
    const adapter = makeAdapter(
      mockFetch({
        '/rest/api/1.0/dashboard/pull-requests': () => ({
          size: 1,
          limit: 50,
          isLastPage: true,
          start: 0,
          values: [samplePR],
        }),
        '/rest/api/1.0/projects/FX/repos/fx-help/pull-requests/1022/merge': () => ({
          canMerge: false,
          conflicted: true,
          outcome: 'CONFLICTED',
        }),
      }),
    );
    const prs = await adapter.listPendingPullRequests();
    expect(prs[0]!.hasConflict).toBe(true);
  });

  it('treats /merge fetch failure as no conflict (保守, 不误标 ignored)', async () => {
    const adapter = makeAdapter(
      mockFetch({
        '/rest/api/1.0/dashboard/pull-requests': () => ({
          size: 1,
          limit: 50,
          isLastPage: true,
          start: 0,
          values: [samplePR],
        }),
        // /merge 端点缺失 → mockFetch 默认 404
      }),
    );
    const prs = await adapter.listPendingPullRequests();
    expect(prs[0]!.hasConflict).toBe(false);
  });

  it('follows pagination across pages', async () => {
    let calls = 0;
    const adapter = makeAdapter(
      mockFetch({
        '/rest/api/1.0/dashboard/pull-requests': (url) => {
          calls++;
          const start = Number(url.searchParams.get('start') ?? '0');
          if (start === 0) {
            return {
              size: 51,
              limit: 50,
              isLastPage: false,
              nextPageStart: 50,
              start: 0,
              values: [samplePR],
            };
          }
          return {
            size: 51,
            limit: 50,
            isLastPage: true,
            start: 50,
            values: [{ ...samplePR, id: 1023 }],
          };
        },
      }),
    );
    const prs = await adapter.listPendingPullRequests();
    expect(prs.map((p) => p.remoteId)).toEqual(['1022', '1023']);
    expect(calls).toBe(2);
  });

  it('passes role=REVIEWER and state=OPEN as query params', async () => {
    const seen: URL[] = [];
    const adapter = makeAdapter(
      mockFetch({
        '/rest/api/1.0/dashboard/pull-requests': (url) => {
          seen.push(url);
          return { size: 0, limit: 50, isLastPage: true, start: 0, values: [] };
        },
      }),
    );
    await adapter.listPendingPullRequests();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.searchParams.get('role')).toBe('REVIEWER');
    expect(seen[0]!.searchParams.get('state')).toBe('OPEN');
  });

  it('throws BBClientError on 401', async () => {
    const adapter = makeAdapter(
      mockFetch(
        {
          '/rest/api/1.0/dashboard/pull-requests': () => ({
            errors: [{ message: 'Authentication failed' }],
          }),
        },
        401,
      ),
    );
    await expect(adapter.listPendingPullRequests()).rejects.toBeInstanceOf(BBClientError);
  });
});

describe('BitbucketServerAdapter.listPullRequestComments anchor 映射', () => {
  const user = { name: 'u1', displayName: 'User One', slug: 'u1', active: true };
  const mkComment = (id: number, text: string) => ({
    id,
    version: 0,
    text,
    author: user,
    createdDate: Date.parse('2026-05-28T01:00:00Z'),
    updatedDate: Date.parse('2026-05-28T01:00:00Z'),
  });
  const activities = (values: unknown[]) => ({
    '/rest/api/1.0/projects/FX/repos/fx-help/pull-requests/1022/activities': () => ({
      size: values.length,
      limit: 25,
      isLastPage: true,
      start: 0,
      values,
    }),
  });

  it('行级 anchor → 映射 path/line/side/lineType', async () => {
    const adapter = makeAdapter(
      mockFetch(
        activities([
          {
            id: 1,
            action: 'COMMENTED',
            commentAction: 'ADDED',
            comment: mkComment(10, '行评论'),
            commentAnchor: { path: 'src/a.ts', line: 42, lineType: 'ADDED', fileType: 'TO' },
          },
        ]),
      ),
    );
    const cs = await adapter.listPullRequestComments({ projectKey: 'FX', repoSlug: 'fx-help' }, '1022');
    expect(cs[0]!.anchor).toEqual({ path: 'src/a.ts', line: 42, side: 'new', lineType: 'added' });
  });

  it('二进制 / 文件级评论 anchor 无 line/lineType → 降级 anchor=null（不崩）', async () => {
    const adapter = makeAdapter(
      mockFetch(
        activities([
          {
            id: 2,
            action: 'COMMENTED',
            commentAction: 'ADDED',
            comment: mkComment(20, '二进制文件上的评论'),
            commentAnchor: { path: 'assets/logo.png', fileType: 'TO' },
          },
        ]),
      ),
    );
    const cs = await adapter.listPullRequestComments({ projectKey: 'FX', repoSlug: 'fx-help' }, '1022');
    expect(cs).toHaveLength(1);
    expect(cs[0]!.anchor).toBeNull();
  });

  it('有 line 缺 lineType → lineType 兜底 context', async () => {
    const adapter = makeAdapter(
      mockFetch(
        activities([
          {
            id: 3,
            action: 'COMMENTED',
            commentAction: 'ADDED',
            comment: mkComment(30, '缺 lineType'),
            commentAnchor: { path: 'src/b.ts', line: 10, fileType: 'FROM' },
          },
        ]),
      ),
    );
    const cs = await adapter.listPullRequestComments({ projectKey: 'FX', repoSlug: 'fx-help' }, '1022');
    expect(cs[0]!.anchor).toEqual({ path: 'src/b.ts', line: 10, side: 'old', lineType: 'context' });
  });
});

describe('BitbucketServerAdapter.mergePullRequest', () => {
  it('fetches current version then POSTs /merge?version=N', async () => {
    let mergeVersion: string | null = 'unset';
    const adapter = makeAdapter(
      mockFetch({
        // GET 单个 PR 拿 version
        '/rest/api/1.0/projects/FX/repos/fx-help/pull-requests/1022': () => samplePR,
        // POST 合并：捕获 version query
        '/rest/api/1.0/projects/FX/repos/fx-help/pull-requests/1022/merge': (url) => {
          mergeVersion = url.searchParams.get('version');
          return { ...samplePR, state: 'MERGED' };
        },
      }),
    );
    await adapter.mergePullRequest({ projectKey: 'FX', repoSlug: 'fx-help' }, '1022');
    // 用的是 GET 回来的最新 version (samplePR.version=5)，不是任何缓存值
    expect(mergeVersion).toBe('5');
  });
});

describe('BitbucketServerAdapter.setPullRequestReviewStatus', () => {
  // approve / needs work / unapproved (撤销) 三个状态映射到 BBS PUT participants 端点
  function captureFetch(): {
    fetchFn: FetchLike;
    calls: { method: string; url: string; body: string | undefined }[];
  } {
    const calls: { method: string; url: string; body: string | undefined }[] = [];
    const fetchFn: FetchLike = async (input, init) => {
      const url = new URL(input);
      calls.push({
        method: init?.method ?? 'GET',
        url: url.pathname,
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      // ping 第一阶段：application-properties
      if (url.pathname === '/rest/api/1.0/application-properties') {
        return new Response(
          JSON.stringify({ version: '8.0.0', buildNumber: '8000', displayName: 'Bitbucket' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json', 'x-ausername': 'kyle' },
          },
        );
      }
      if (url.pathname === '/rest/api/1.0/users/kyle') {
        return new Response(
          JSON.stringify({
            name: 'kyle.smith',
            displayName: 'Kyle Smith',
            active: true,
            slug: 'kyle',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // PUT participants：返回 200 + 模拟 BBS 响应体（实际不读，但需要解析成功）
      if (url.pathname.includes('/participants/')) {
        return new Response(JSON.stringify({ approved: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    };
    return { fetchFn, calls };
  }

  it('PUT /participants/<slug> with APPROVED + user.name', async () => {
    const { fetchFn, calls } = captureFetch();
    const adapter = makeAdapter(fetchFn);
    await adapter.ping();
    await adapter.setPullRequestReviewStatus(
      { projectKey: 'FX', repoSlug: 'fx-help' },
      '1022',
      'approved',
    );
    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toBeDefined();
    expect(put!.url).toBe(
      '/rest/api/1.0/projects/FX/repos/fx-help/pull-requests/1022/participants/kyle',
    );
    expect(JSON.parse(put!.body!)).toEqual({
      status: 'APPROVED',
      user: { name: 'kyle.smith' },
    });
  });

  it('maps needsWork → NEEDS_WORK in body', async () => {
    const { fetchFn, calls } = captureFetch();
    const adapter = makeAdapter(fetchFn);
    await adapter.ping();
    await adapter.setPullRequestReviewStatus(
      { projectKey: 'FX', repoSlug: 'fx-help' },
      '1022',
      'needsWork',
    );
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(JSON.parse(put.body!).status).toBe('NEEDS_WORK');
  });

  it('maps unapproved → UNAPPROVED (撤销之前的标记)', async () => {
    const { fetchFn, calls } = captureFetch();
    const adapter = makeAdapter(fetchFn);
    await adapter.ping();
    await adapter.setPullRequestReviewStatus(
      { projectKey: 'FX', repoSlug: 'fx-help' },
      '1022',
      'unapproved',
    );
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(JSON.parse(put.body!).status).toBe('UNAPPROVED');
  });

  it('throws if ping() not called first (cachedUser unknown)', async () => {
    const { fetchFn } = captureFetch();
    const adapter = makeAdapter(fetchFn);
    await expect(
      adapter.setPullRequestReviewStatus(
        { projectKey: 'FX', repoSlug: 'fx-help' },
        '1022',
        'approved',
      ),
    ).rejects.toThrow(/current user unknown/);
  });
});
