import { describe, expect, it } from 'vitest';
import { GitLabAdapter, normalizeGitLabApiBase } from '../src/adapter.js';

// ---- Route-style mock fetch: match by method + URL substring (array order takes priority), return JSON Response, record requests ----
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

function makeAdapter(
  routes: Route[],
  opts?: { cloneProtocol?: 'pat' | 'ssh'; baseUrl?: string },
): { adapter: GitLabAdapter; captured: Captured[] } {
  const captured: Captured[] = [];
  const adapter = new GitLabAdapter({
    baseUrl: opts?.baseUrl ?? 'https://gitlab.com/api/v4',
    token: 'tok',
    cloneProtocol: opts?.cloneProtocol,
    fetch: makeFetch(routes, captured),
  });
  return { adapter, captured };
}

const ME = { id: 1, username: 'alice', name: 'Alice' };

describe('GitLabAdapter ping / edition / capabilities', () => {
  it('EE instance (metadata.enterprise=true) exposes approve/unapprove approval', async () => {
    const { adapter } = makeAdapter([
      { match: '/user', body: ME },
      { match: '/metadata', body: { version: '16.5.0-ee', enterprise: true } },
    ]);
    const res = await adapter.connection.ping();
    expect(res.ok).toBe(true);
    expect(res.user?.name).toBe('alice');
    expect(res.serverVersion).toBe('16.5.0-ee');
    expect(adapter.connection.capabilities().reviewStatuses).toEqual(['approved', 'unapproved']);
    // GitLab has no needsWork
    expect(adapter.connection.capabilities().reviewStatuses).not.toContain('needsWork');
  });

  it('CE instance (enterprise=false) degrades approval to empty', async () => {
    const { adapter } = makeAdapter([
      { match: '/user', body: ME },
      { match: '/metadata', body: { version: '16.5.0', enterprise: false } },
    ]);
    await adapter.connection.ping();
    expect(adapter.connection.capabilities().reviewStatuses).toEqual([]);
  });

  it('/metadata unavailable (old instance) falls back to /version, conservatively assumes CE', async () => {
    const { adapter } = makeAdapter([
      { match: '/user', body: ME },
      { match: '/metadata', status: 404, body: { message: '404' } },
      { match: '/version', body: { version: '14.0.0' } },
    ]);
    const res = await adapter.connection.ping();
    expect(res.serverVersion).toBe('14.0.0');
    expect(adapter.connection.capabilities().reviewStatuses).toEqual([]);
  });

  it('capabilities: full fidelity / no optimistic lock / not rate-limited', () => {
    const { adapter } = makeAdapter([]);
    const c = adapter.connection.capabilities();
    expect(c.mergeVetoFidelity).toBe('full');
    expect(c.commentOptimisticLock).toBe(false);
    // GitLab uses standard CommonMark line breaks (single \n = space), not hard-break
    expect(c.commentHardBreaks).toBe(false);
    expect(c.discoveryRateLimited).toBe(false);
    expect(c.inlineComments).toBe(true);
    expect(c.discoveryFilters).toEqual(['review-requested', 'created', 'assigned']);
  });
});

const MR_LIST_ITEM = {
  id: 100,
  iid: 3,
  project_id: 42,
  web_url: 'https://gitlab.com/group/sub/proj/-/merge_requests/3',
};
const MR_DETAIL = {
  id: 100,
  iid: 3,
  project_id: 42,
  title: 'Add feature',
  description: 'desc',
  state: 'opened',
  draft: false,
  web_url: 'https://gitlab.com/group/sub/proj/-/merge_requests/3',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  author: { id: 2, username: 'bob', name: 'Bob' },
  source_branch: 'feat',
  target_branch: 'main',
  sha: 'headsha',
  reviewers: [ME],
  detailed_merge_status: 'not_approved',
  has_conflicts: false,
  diff_refs: { base_sha: 'basesha', head_sha: 'headsha', start_sha: 'startsha' },
};

describe('GitLabAdapter discovery', () => {
  it('listPendingPullRequests: MR mapping + nested group path + approval status', async () => {
    const { adapter, captured } = makeAdapter([
      { match: '/user', body: ME },
      { match: '/metadata', body: { version: '16.5.0', enterprise: true } },
      { match: '/merge_requests/3/approvals', body: { approved_by: [{ user: ME }] } },
      { match: '/projects/42/merge_requests/3', body: MR_DETAIL },
      { match: '/merge_requests', body: [MR_LIST_ITEM] },
    ]);
    await adapter.connection.ping();
    const prs = await adapter.prs.listPendingPullRequests();
    expect(prs).toHaveLength(1);
    const pr = prs[0]!;
    expect(pr.remoteId).toBe('3');
    expect(pr.repo).toEqual({ projectKey: 'group/sub', repoSlug: 'proj' });
    expect(pr.sourceRef.sha).toBe('headsha');
    expect(pr.targetRef.sha).toBe('basesha');
    // not_approved → not mergeable + full veto
    expect(pr.mergeStatus.canMerge).toBe(false);
    expect(pr.mergeStatus.vetoes.length).toBeGreaterThan(0);
    // the approved ME is marked approved
    expect(pr.reviewers.find((r) => r.name === 'alice')?.status).toBe('approved');
    // the discovery request carries reviewer_username
    const listReq = captured.find((c) => c.url.includes('/merge_requests?'));
    expect(listReq?.url).toContain('reviewer_username=alice');
  });

  it('discovery filter: created → author_username; assigned → assignee_username', async () => {
    const mk = () =>
      makeAdapter([
        { match: '/user', body: ME },
        { match: '/metadata', body: { version: '16', enterprise: false } },
        { match: '/merge_requests', body: [] },
      ]);
    const a = mk();
    await a.adapter.connection.ping();
    await a.adapter.prs.listPendingPullRequests({ filter: 'created' });
    expect(a.captured.find((c) => c.url.includes('/merge_requests?'))?.url).toContain(
      'author_username=alice',
    );

    const b = mk();
    await b.adapter.connection.ping();
    await b.adapter.prs.listPendingPullRequests({ filter: 'assigned' });
    expect(b.captured.find((c) => c.url.includes('/merge_requests?'))?.url).toContain(
      'assignee_username=alice',
    );
  });
});

describe('GitLabAdapter comment tree (discussions/notes)', () => {
  it('inline discussion → top-level + replies; system note filtered; threadId=discussion id', async () => {
    const discussions = [
      {
        id: 'disc1',
        notes: [
          {
            id: 11,
            type: 'DiffNote',
            body: 'inline top',
            author: { id: 2, username: 'bob', name: 'Bob' },
            created_at: 't1',
            updated_at: 't1',
            system: false,
            position: {
              position_type: 'text',
              new_path: 'a.ts',
              new_line: 5,
              base_sha: 'b',
              head_sha: 'h',
              start_sha: 's',
            },
          },
          {
            id: 12,
            type: 'DiffNote',
            body: 'reply',
            author: ME,
            created_at: 't2',
            updated_at: 't2',
            system: false,
          },
        ],
      },
      {
        id: 'disc2',
        notes: [
          { id: 99, body: 'merged', author: ME, created_at: 't', updated_at: 't', system: true },
        ],
      },
    ];
    const { adapter } = makeAdapter([
      { match: '/user', body: ME },
      { match: '/metadata', body: { version: '16.0.0', enterprise: false } },
      { match: '/discussions', body: discussions },
    ]);
    await adapter.connection.ping();
    const comments = await adapter.comments.listPullRequestComments(
      { projectKey: 'group', repoSlug: 'proj' },
      '3',
    );
    // system-only discussion is filtered out
    expect(comments).toHaveLength(1);
    const top = comments[0]!;
    expect(top.kind).toBe('inline');
    expect(top.anchor).toEqual({ path: 'a.ts', line: 5, side: 'new', lineType: 'added' });
    expect(top.threadId).toBe('disc1');
    expect(top.remoteId).toBe('11');
    expect(top.replies).toHaveLength(1);
    expect(top.replies[0]!.canEdit).toBe(true); // reply author is ME
    expect(top.canEdit).toBe(false); // top author is bob
    // no-optimistic-lock sentinel: version=0, making the edit/delete IPC's version:number contract and ownership decision pass uniformly
    expect(top.version).toBe(0);
    expect(top.replies[0]!.version).toBe(0);
  });
});

describe('GitLabAdapter write path + clone', () => {
  it('clone url: pat embeds user:token; ssh uses git@host', async () => {
    const pat = makeAdapter([
      { match: '/user', body: ME },
      { match: '/metadata', body: { version: '16', enterprise: false } },
    ]);
    await pat.adapter.connection.ping();
    const url = await pat.adapter.connection.getCloneUrl({
      projectKey: 'group/sub',
      repoSlug: 'proj',
    });
    expect(url).toBe('https://alice:tok@gitlab.com/group/sub/proj.git');

    const ssh = makeAdapter([], { cloneProtocol: 'ssh' });
    expect(
      await ssh.adapter.connection.getCloneUrl({ projectKey: 'group', repoSlug: 'proj' }),
    ).toBe('git@gitlab.com:group/proj.git');
  });

  it('approve → POST /approve; unapprove → POST /unapprove', async () => {
    const { adapter, captured } = makeAdapter([
      { method: 'POST', match: '/approve', body: {} },
      { method: 'POST', match: '/unapprove', body: {} },
    ]);
    await adapter.prs.setPullRequestReviewStatus(
      { projectKey: 'g', repoSlug: 'p' },
      '3',
      'approved',
    );
    await adapter.prs.setPullRequestReviewStatus(
      { projectKey: 'g', repoSlug: 'p' },
      '3',
      'unapproved',
    );
    expect(captured.some((c) => c.method === 'POST' && c.url.endsWith('/approve'))).toBe(true);
    expect(captured.some((c) => c.method === 'POST' && c.url.endsWith('/unapprove'))).toBe(true);
  });

  it('needsWork throws (GitLab has no such concept)', async () => {
    const { adapter } = makeAdapter([]);
    await expect(
      adapter.prs.setPullRequestReviewStatus({ projectKey: 'g', repoSlug: 'p' }, '3', 'needsWork'),
    ).rejects.toThrow();
  });

  it('publishInlineComment: fetch diff_refs first, position carries three shas + new_line', async () => {
    const { adapter, captured } = makeAdapter([
      { match: '/user', body: ME },
      {
        method: 'POST',
        match: '/discussions',
        body: {
          id: 'd9',
          notes: [
            {
              id: 77,
              body: 'x',
              author: ME,
              created_at: 't',
              updated_at: 't',
              position: { position_type: 'text', new_path: 'a.ts', new_line: 5 },
            },
          ],
        },
      },
      { method: 'GET', match: '/merge_requests/3', body: MR_DETAIL },
    ]);
    await adapter.connection.ping();
    const created = await adapter.comments.publishInlineComment(
      { projectKey: 'g', repoSlug: 'p' },
      '3',
      { path: 'a.ts', line: 5, side: 'new', lineType: 'added' },
      'hello',
    );
    expect(created.remoteId).toBe('77');
    const post = captured.find((c) => c.method === 'POST' && c.url.includes('/discussions'));
    const pos = (post?.body as { position: Record<string, unknown> }).position;
    expect(pos.base_sha).toBe('basesha');
    expect(pos.head_sha).toBe('headsha');
    expect(pos.new_line).toBe(5);
  });
});

describe('normalizeGitLabApiBase', () => {
  it('gitlab.com SaaS: official API base kept as-is (does not break public SaaS integration)', () => {
    expect(normalizeGitLabApiBase('https://gitlab.com/api/v4')).toBe('https://gitlab.com/api/v4');
  });

  it('instance root address auto-appends /api/v4', () => {
    expect(normalizeGitLabApiBase('https://gitlab.example.com')).toBe(
      'https://gitlab.example.com/api/v4',
    );
    expect(normalizeGitLabApiBase('https://gitlab.example.com/')).toBe(
      'https://gitlab.example.com/api/v4',
    );
  });

  it('already carries /api/v4 kept as-is (trailing slash normalized)', () => {
    expect(normalizeGitLabApiBase('https://gitlab.example.com/api/v4/')).toBe(
      'https://gitlab.example.com/api/v4',
    );
  });

  it('relative-url-root subpath install: append after the subpath', () => {
    expect(normalizeGitLabApiBase('https://example.com/gitlab')).toBe(
      'https://example.com/gitlab/api/v4',
    );
  });
});

describe('GitLabAdapter avatar proxy', () => {
  it('this-instance avatar: fetch with PAT', async () => {
    const { adapter, captured } = makeAdapter([
      { match: '/uploads/', body: 'PNG', headers: { 'content-type': 'image/png' } },
    ]);
    const res = await adapter.media.getUserAvatar(
      'alice',
      'https://gitlab.com/uploads/-/system/user/avatar/2/avatar.png',
    );
    expect(res).not.toBeNull();
    const req = captured.find((c) => c.url.includes('/uploads/'));
    expect(req?.headers['PRIVATE-TOKEN']).toBe('tok');
  });

  it('gravatar avatar: fetch directly over the public internet, never with PAT', async () => {
    const { adapter, captured } = makeAdapter([
      { match: 'gravatar.com', body: 'PNG', headers: { 'content-type': 'image/png' } },
    ]);
    const res = await adapter.media.getUserAvatar(
      'alice',
      'https://www.gravatar.com/avatar/abc?s=80',
    );
    expect(res).not.toBeNull();
    const req = captured.find((c) => c.url.includes('gravatar.com'));
    expect(req).toBeDefined();
    expect(req?.headers['PRIVATE-TOKEN']).toBeUndefined();
  });

  it('other external hosts: not proxy-fetched (SSRF prevention)', async () => {
    const { adapter } = makeAdapter([{ match: 'evil.example.com', body: 'x' }]);
    const res = await adapter.media.getUserAvatar('alice', 'https://evil.example.com/x.png');
    expect(res).toBeNull();
  });
});

describe('GitLabAdapter attachment proxy', () => {
  const SECRET = 'f28aebc97ff910addda099ad1a4456d3';

  it('/uploads (absolute instance URL) uses the API download endpoint, with PAT', async () => {
    const { adapter, captured } = makeAdapter([
      { match: '/api/v4/projects/', body: 'PNG', headers: { 'content-type': 'image/png' } },
    ]);
    const res = await adapter.media.getAttachment(
      `https://gitlab.com/group/proj/uploads/${SECRET}/image.png`,
      { projectKey: 'group', repoSlug: 'proj' },
    );
    expect(res).not.toBeNull();
    const req = captured.find((c) => c.url.includes('/uploads/'));
    expect(req?.url).toContain(`/api/v4/projects/group%2Fproj/uploads/${SECRET}/image.png`);
    expect(req?.headers['PRIVATE-TOKEN']).toBe('tok');
  });

  it('/uploads (relative path) also maps to the API endpoint', async () => {
    const { adapter, captured } = makeAdapter([
      { match: '/api/v4/projects/', body: 'PNG', headers: { 'content-type': 'image/png' } },
    ]);
    await adapter.media.getAttachment(`/uploads/${SECRET}/image.png`, {
      projectKey: 'group/sub',
      repoSlug: 'proj',
    });
    const req = captured.find((c) => c.url.includes('/uploads/'));
    expect(req?.url).toContain(`/api/v4/projects/group%2Fsub%2Fproj/uploads/${SECRET}/image.png`);
  });

  it('API returns text/html (old versions lack the endpoint / login redirect) → null (avoid treating HTML as an image)', async () => {
    const { adapter } = makeAdapter([
      {
        match: '/api/v4/projects/',
        body: '<html>sign in</html>',
        headers: { 'content-type': 'text/html; charset=utf-8' },
      },
    ]);
    const res = await adapter.media.getAttachment(`/uploads/${SECRET}/image.png`, {
      projectKey: 'group',
      repoSlug: 'proj',
    });
    expect(res).toBeNull();
  });
});
