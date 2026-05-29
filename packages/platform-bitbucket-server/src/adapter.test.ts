import { describe, expect, it } from 'vitest';
import { BitbucketServerAdapter } from './adapter.js';
import type { FetchLike } from './client.js';
import { BBClientError } from './client.js';

type RouteHandler = (url: URL) => unknown;

function mockFetch(routes: Record<string, RouteHandler>, status = 200): FetchLike {
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
      headers: { 'content-type': 'application/json' },
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
      }),
    );
    const prs = await adapter.listPendingPullRequests();
    expect(prs).toHaveLength(1);
    expect(prs[0]).toEqual({
      remoteId: '1022',
      title: 'feat 发布搜索和AI优化',
      description: '',
      author: { name: 'musk.chen', displayName: 'Musk.Chen-高晨' },
      state: 'open',
      draft: false,
      sourceRef: { displayId: 'dev', sha: 'abc123' },
      targetRef: { displayId: 'master', sha: 'def456' },
      repo: { projectKey: 'FX', repoSlug: 'fx-help' },
      url: 'https://bb.example.com/projects/FX/repos/fx-help/pull-requests/1022',
      createdAt: new Date(Date.parse('2026-05-28T01:00:00Z')).toISOString(),
      updatedAt: new Date(Date.parse('2026-05-28T09:30:43Z')).toISOString(),
      reviewers: [{ name: 'reviewer1', displayName: 'Reviewer One', approved: true }],
    });
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
