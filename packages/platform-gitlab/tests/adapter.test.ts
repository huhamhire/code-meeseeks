import { describe, expect, it } from 'vitest';
import { GitLabAdapter, normalizeGitLabApiBase } from '../src/adapter.js';

// ---- 路由式 mock fetch：按 method + URL 子串匹配（数组序优先），返回 JSON Response，记录请求 ----
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
  it('EE 实例（metadata.enterprise=true）暴露 approve/unapprove 审批', async () => {
    const { adapter } = makeAdapter([
      { match: '/user', body: ME },
      { match: '/metadata', body: { version: '16.5.0-ee', enterprise: true } },
    ]);
    const res = await adapter.ping();
    expect(res.ok).toBe(true);
    expect(res.user?.name).toBe('alice');
    expect(res.serverVersion).toBe('16.5.0-ee');
    expect(adapter.capabilities().reviewStatuses).toEqual(['approved', 'unapproved']);
    // GitLab 无 needsWork
    expect(adapter.capabilities().reviewStatuses).not.toContain('needsWork');
  });

  it('CE 实例（enterprise=false）审批降级为空', async () => {
    const { adapter } = makeAdapter([
      { match: '/user', body: ME },
      { match: '/metadata', body: { version: '16.5.0', enterprise: false } },
    ]);
    await adapter.ping();
    expect(adapter.capabilities().reviewStatuses).toEqual([]);
  });

  it('/metadata 不可用（旧实例）退 /version，保守按 CE', async () => {
    const { adapter } = makeAdapter([
      { match: '/user', body: ME },
      { match: '/metadata', status: 404, body: { message: '404' } },
      { match: '/version', body: { version: '14.0.0' } },
    ]);
    const res = await adapter.ping();
    expect(res.serverVersion).toBe('14.0.0');
    expect(adapter.capabilities().reviewStatuses).toEqual([]);
  });

  it('capabilities：full 保真 / 无乐观锁 / 不限流', () => {
    const { adapter } = makeAdapter([]);
    const c = adapter.capabilities();
    expect(c.mergeVetoFidelity).toBe('full');
    expect(c.commentOptimisticLock).toBe(false);
    // GitLab 走标准 CommonMark 换行（单 \n = 空格），非 hard-break
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

describe('GitLabAdapter 发现', () => {
  it('listPendingPullRequests：MR 映射 + 嵌套 group 路径 + 审批状态', async () => {
    const { adapter, captured } = makeAdapter([
      { match: '/user', body: ME },
      { match: '/metadata', body: { version: '16.5.0', enterprise: true } },
      { match: '/merge_requests/3/approvals', body: { approved_by: [{ user: ME }] } },
      { match: '/projects/42/merge_requests/3', body: MR_DETAIL },
      { match: '/merge_requests', body: [MR_LIST_ITEM] },
    ]);
    await adapter.ping();
    const prs = await adapter.listPendingPullRequests();
    expect(prs).toHaveLength(1);
    const pr = prs[0]!;
    expect(pr.remoteId).toBe('3');
    expect(pr.repo).toEqual({ projectKey: 'group/sub', repoSlug: 'proj' });
    expect(pr.sourceRef.sha).toBe('headsha');
    expect(pr.targetRef.sha).toBe('basesha');
    // not_approved → 不可合并 + full veto
    expect(pr.mergeStatus.canMerge).toBe(false);
    expect(pr.mergeStatus.vetoes.length).toBeGreaterThan(0);
    // 已批的 ME 标 approved
    expect(pr.reviewers.find((r) => r.name === 'alice')?.status).toBe('approved');
    // 发现请求带 reviewer_username
    const listReq = captured.find((c) => c.url.includes('/merge_requests?'));
    expect(listReq?.url).toContain('reviewer_username=alice');
  });

  it('discovery filter：created → author_username；assigned → assignee_username', async () => {
    const mk = () =>
      makeAdapter([
        { match: '/user', body: ME },
        { match: '/metadata', body: { version: '16', enterprise: false } },
        { match: '/merge_requests', body: [] },
      ]);
    const a = mk();
    await a.adapter.ping();
    await a.adapter.listPendingPullRequests({ filter: 'created' });
    expect(a.captured.find((c) => c.url.includes('/merge_requests?'))?.url).toContain(
      'author_username=alice',
    );

    const b = mk();
    await b.adapter.ping();
    await b.adapter.listPendingPullRequests({ filter: 'assigned' });
    expect(b.captured.find((c) => c.url.includes('/merge_requests?'))?.url).toContain(
      'assignee_username=alice',
    );
  });
});

describe('GitLabAdapter 评论树（discussions/notes）', () => {
  it('inline discussion → 顶层 + replies；system note 过滤；threadId=discussion id', async () => {
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
            position: { position_type: 'text', new_path: 'a.ts', new_line: 5, base_sha: 'b', head_sha: 'h', start_sha: 's' },
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
      { id: 'disc2', notes: [{ id: 99, body: 'merged', author: ME, created_at: 't', updated_at: 't', system: true }] },
    ];
    const { adapter } = makeAdapter([
      { match: '/user', body: ME },
      { match: '/metadata', body: { version: '16.0.0', enterprise: false } },
      { match: '/discussions', body: discussions },
    ]);
    await adapter.ping();
    const comments = await adapter.listPullRequestComments({ projectKey: 'group', repoSlug: 'proj' }, '3');
    // system-only discussion 被过滤
    expect(comments).toHaveLength(1);
    const top = comments[0]!;
    expect(top.kind).toBe('inline');
    expect(top.anchor).toEqual({ path: 'a.ts', line: 5, side: 'new', lineType: 'added' });
    expect(top.threadId).toBe('disc1');
    expect(top.remoteId).toBe('11');
    expect(top.replies).toHaveLength(1);
    expect(top.replies[0]!.canEdit).toBe(true); // reply 作者是 ME
    expect(top.canEdit).toBe(false); // top 作者是 bob
  });
});

describe('GitLabAdapter 写路径 + clone', () => {
  it('clone url：pat 嵌用户:token；ssh 走 git@host', async () => {
    const pat = makeAdapter([{ match: '/user', body: ME }, { match: '/metadata', body: { version: '16', enterprise: false } }]);
    await pat.adapter.ping();
    const url = await pat.adapter.getCloneUrl({ projectKey: 'group/sub', repoSlug: 'proj' });
    expect(url).toBe('https://alice:tok@gitlab.com/group/sub/proj.git');

    const ssh = makeAdapter([], { cloneProtocol: 'ssh' });
    expect(await ssh.adapter.getCloneUrl({ projectKey: 'group', repoSlug: 'proj' })).toBe(
      'git@gitlab.com:group/proj.git',
    );
  });

  it('approve → POST /approve；unapprove → POST /unapprove', async () => {
    const { adapter, captured } = makeAdapter([
      { method: 'POST', match: '/approve', body: {} },
      { method: 'POST', match: '/unapprove', body: {} },
    ]);
    await adapter.setPullRequestReviewStatus({ projectKey: 'g', repoSlug: 'p' }, '3', 'approved');
    await adapter.setPullRequestReviewStatus({ projectKey: 'g', repoSlug: 'p' }, '3', 'unapproved');
    expect(captured.some((c) => c.method === 'POST' && c.url.endsWith('/approve'))).toBe(true);
    expect(captured.some((c) => c.method === 'POST' && c.url.endsWith('/unapprove'))).toBe(true);
  });

  it('needsWork 抛错（GitLab 无此概念）', async () => {
    const { adapter } = makeAdapter([]);
    await expect(
      adapter.setPullRequestReviewStatus({ projectKey: 'g', repoSlug: 'p' }, '3', 'needsWork'),
    ).rejects.toThrow();
  });

  it('publishInlineComment：先拉 diff_refs，position 带三 sha + new_line', async () => {
    const { adapter, captured } = makeAdapter([
      { match: '/user', body: ME },
      { method: 'POST', match: '/discussions', body: { id: 'd9', notes: [{ id: 77, body: 'x', author: ME, created_at: 't', updated_at: 't', position: { position_type: 'text', new_path: 'a.ts', new_line: 5 } }] } },
      { method: 'GET', match: '/merge_requests/3', body: MR_DETAIL },
    ]);
    await adapter.ping();
    const created = await adapter.publishInlineComment(
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
  it('gitlab.com SaaS：官方 API base 原样保留（不破坏公共 SaaS 对接）', () => {
    expect(normalizeGitLabApiBase('https://gitlab.com/api/v4')).toBe('https://gitlab.com/api/v4');
  });

  it('实例根地址自动补 /api/v4', () => {
    expect(normalizeGitLabApiBase('https://gitlab.example.com')).toBe(
      'https://gitlab.example.com/api/v4',
    );
    expect(normalizeGitLabApiBase('https://gitlab.example.com/')).toBe(
      'https://gitlab.example.com/api/v4',
    );
  });

  it('已带 /api/v4 原样（含尾斜杠归一）', () => {
    expect(normalizeGitLabApiBase('https://gitlab.example.com/api/v4/')).toBe(
      'https://gitlab.example.com/api/v4',
    );
  });

  it('relative-url-root 子路径安装：补在子路径之后', () => {
    expect(normalizeGitLabApiBase('https://example.com/gitlab')).toBe(
      'https://example.com/gitlab/api/v4',
    );
  });
});

describe('GitLabAdapter 头像代理', () => {
  it('本实例头像：带 PAT 取', async () => {
    const { adapter, captured } = makeAdapter([
      { match: '/uploads/', body: 'PNG', headers: { 'content-type': 'image/png' } },
    ]);
    const res = await adapter.getUserAvatar(
      'alice',
      'https://gitlab.com/uploads/-/system/user/avatar/2/avatar.png',
    );
    expect(res).not.toBeNull();
    const req = captured.find((c) => c.url.includes('/uploads/'));
    expect(req?.headers['PRIVATE-TOKEN']).toBe('tok');
  });

  it('gravatar 头像：公网直取，绝不带 PAT', async () => {
    const { adapter, captured } = makeAdapter([
      { match: 'gravatar.com', body: 'PNG', headers: { 'content-type': 'image/png' } },
    ]);
    const res = await adapter.getUserAvatar('alice', 'https://www.gravatar.com/avatar/abc?s=80');
    expect(res).not.toBeNull();
    const req = captured.find((c) => c.url.includes('gravatar.com'));
    expect(req).toBeDefined();
    expect(req?.headers['PRIVATE-TOKEN']).toBeUndefined();
  });

  it('其它外部 host：不代拉（防 SSRF）', async () => {
    const { adapter } = makeAdapter([{ match: 'evil.example.com', body: 'x' }]);
    const res = await adapter.getUserAvatar('alice', 'https://evil.example.com/x.png');
    expect(res).toBeNull();
  });
});
