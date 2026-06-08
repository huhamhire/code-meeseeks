import type {
  ListPendingOptions,
  MergeStatus,
  MergeVeto,
  PingResult,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformUser,
  PrComment,
  PrCommentAnchor,
  PrCommit,
  PrDiscoveryFilter,
  PullRequest,
  RepoRef,
  Reviewer,
  ReviewerStatus,
} from '@meebox/shared';
import { GitHubClient, GitHubClientError, type GitHubClientOptions } from './client.js';

// ---- GitHub REST 响应形状（仅取用到的字段）----

interface GhUser {
  login: string;
  id: number;
  name?: string | null;
  avatar_url?: string;
  html_url?: string;
}

interface GhRepoRef {
  ref: string;
  sha: string;
  repo: { name: string; owner: { login: string } } | null;
}

interface GhPull {
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  draft?: boolean;
  merged?: boolean;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: GhUser;
  head: GhRepoRef;
  base: GhRepoRef;
  requested_reviewers?: GhUser[];
  mergeable?: boolean | null;
  mergeable_state?: string;
}

interface GhReview {
  id: number;
  user: GhUser | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submitted_at?: string;
}

interface GhIssueComment {
  id: number;
  user: GhUser;
  body: string;
  created_at: string;
  updated_at: string;
  html_url?: string;
}

interface GhReviewComment {
  id: number;
  user: GhUser;
  body: string;
  created_at: string;
  updated_at: string;
  path: string;
  line?: number | null;
  original_line?: number | null;
  side?: 'LEFT' | 'RIGHT';
  start_line?: number | null;
  in_reply_to_id?: number;
  html_url?: string;
}

interface GhCommit {
  sha: string;
  html_url?: string;
  commit: {
    message: string;
    author?: { name?: string; email?: string; date?: string };
    committer?: { name?: string; email?: string; date?: string };
  };
  parents: Array<{ sha: string }>;
  author: GhUser | null;
  committer: GhUser | null;
}

/** search/issues 命中项（PR 形态）；repository_url 形如 https://api.github.com/repos/{o}/{r} */
interface GhSearchItem {
  number: number;
  repository_url: string;
  pull_request?: unknown;
}

/** 发现筛选分类 → GitHub search 主体限定词（对齐仪表盘四类）。 */
const FILTER_QUALIFIER: Record<PrDiscoveryFilter, string> = {
  'review-requested': 'review-requested:@me',
  created: 'author:@me',
  assigned: 'assignee:@me',
  mentioned: 'mentions:@me',
};

function discoveryQuery(filter: PrDiscoveryFilter): string {
  return `is:open is:pr ${FILTER_QUALIFIER[filter]} archived:false`;
}

export interface GitHubAdapterOptions extends GitHubClientOptions {
  /** clone 协议：'pat'（默认）走 HTTPS + 用户名:PAT；'ssh' 走系统 ssh 配置 */
  cloneProtocol?: 'pat' | 'ssh';
}

export class GitHubAdapter implements PlatformAdapter {
  readonly kind = 'github' as const;
  private readonly client: GitHubClient;
  private readonly token: string;
  private readonly cloneProtocol: 'pat' | 'ssh';
  /** web / git host base（api.github.com → https://github.com；GHE → 实例 host）。 */
  private readonly webBase: string;
  private readonly gitHost: string;
  private cachedUser: PlatformUser | null = null;

  constructor(opts: GitHubAdapterOptions) {
    this.client = new GitHubClient(opts);
    this.token = opts.token;
    this.cloneProtocol = opts.cloneProtocol ?? 'pat';
    const api = new URL(opts.baseUrl);
    // github.com 的 API 在 api.github.com，但 clone/web 在 github.com；GHE 同 host。
    this.webBase =
      api.hostname === 'api.github.com' ? 'https://github.com' : `${api.protocol}//${api.host}`;
    this.gitHost = new URL(this.webBase).host;
  }

  /**
   * GitHub 能力：三态审批（APPROVE / REQUEST_CHANGES / dismiss）、行内多行评论；无评论乐观锁；
   * 合并否决项只能近似（mergeable_state，partial）；发现走 search 强限流。
   * 「解决线程 / suggestion 应用 / pending-review 成组」当前未实现 → 置 false（Phase 4 再开）。
   */
  capabilities(): PlatformCapabilities {
    return {
      reviewStatuses: ['approved', 'needsWork', 'unapproved'],
      inlineComments: true,
      inlineMultiline: true,
      commentOptimisticLock: false,
      mergeVetoFidelity: 'partial',
      discoveryRateLimited: true,
      resolvableThreads: false,
      suggestions: false,
      reviewGrouping: false,
    };
  }

  async ping(): Promise<PingResult> {
    const { body: me, headers } = await this.client.getWithHeaders<GhUser>('/user');
    this.cachedUser = { name: me.login, displayName: me.name ?? me.login, slug: me.login };
    const gheVersion = headers.get('x-github-enterprise-version');
    return {
      ok: true,
      serverVersion: gheVersion ?? 'github.com',
      user: this.cachedUser,
    };
  }

  getCurrentUser(): PlatformUser | null {
    return this.cachedUser;
  }

  async getCloneUrl(repo: RepoRef): Promise<string> {
    if (this.cloneProtocol === 'ssh') {
      return `git@${this.gitHost}:${repo.projectKey}/${repo.repoSlug}.git`;
    }
    const user = this.cachedUser?.name;
    if (!user) {
      throw new Error(
        'cannot construct PAT clone URL: current user unknown — ping() not called or failed',
      );
    }
    const u = new URL(this.webBase);
    u.pathname = `/${repo.projectKey}/${repo.repoSlug}.git`;
    u.username = user;
    u.password = this.token;
    return u.toString();
  }

  async listPendingPullRequests(opts?: ListPendingOptions): Promise<PullRequest[]> {
    const items: GhSearchItem[] = [];
    for await (const it of this.client.searchItems<GhSearchItem>('/search/issues', {
      q: discoveryQuery(opts?.filter ?? 'review-requested'),
    })) {
      if (it.pull_request) items.push(it);
    }
    // 每条命中再取 PR 详情（sha / mergeable / draft）+ reviews（reviewer 状态）。单个失败丢弃该条。
    const results = await Promise.allSettled(items.map((it) => this.loadPull(it)));
    return results
      .filter((r): r is PromiseFulfilledResult<PullRequest> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  private async loadPull(item: GhSearchItem): Promise<PullRequest> {
    const { owner, repo } = parseRepositoryUrl(item.repository_url);
    const base = `/repos/${owner}/${repo}/pulls/${String(item.number)}`;
    const [pull, reviews] = await Promise.all([
      this.client.get<GhPull>(base),
      collect(this.client.paginate<GhReview>(`${base}/reviews`)),
    ]);
    return mapPull(pull, buildReviewers(pull, reviews), mapMergeStatus(pull));
  }

  async listPullRequestCommits(repo: RepoRef, prId: string): Promise<PrCommit[]> {
    const out: PrCommit[] = [];
    for await (const c of this.client.paginate<GhCommit>(
      `/repos/${repo.projectKey}/${repo.repoSlug}/pulls/${prId}/commits`,
    )) {
      out.push(mapCommit(c));
    }
    // GitHub commits 是 oldest-first；契约要求 newest-first
    return out.reverse();
  }

  async listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]> {
    const prefix = `/repos/${repo.projectKey}/${repo.repoSlug}`;
    const [issueComments, reviewComments] = await Promise.all([
      collect(this.client.paginate<GhIssueComment>(`${prefix}/issues/${prId}/comments`)),
      collect(this.client.paginate<GhReviewComment>(`${prefix}/pulls/${prId}/comments`)),
    ]);

    // issue 评论 = summary（无线程）
    const summary = issueComments.map(mapIssueComment);

    // review 评论 = inline，按 in_reply_to_id 还原成 顶层 + 嵌套 replies
    const repliesByParent = new Map<number, GhReviewComment[]>();
    const tops: GhReviewComment[] = [];
    for (const rc of reviewComments) {
      if (rc.in_reply_to_id != null) {
        const arr = repliesByParent.get(rc.in_reply_to_id) ?? [];
        arr.push(rc);
        repliesByParent.set(rc.in_reply_to_id, arr);
      } else {
        tops.push(rc);
      }
    }
    const inline = tops.map((rc) => {
      const pc = mapReviewComment(rc);
      pc.replies = (repliesByParent.get(rc.id) ?? []).map(mapReviewComment);
      return pc;
    });

    return [...summary, ...inline];
  }

  async getUserAvatar(
    slug: string,
    avatarUrl?: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    // 有 avatar_url 直链优先用它：普通用户走 avatars.githubusercontent.com/u/<id>，
    // 机器人走 .../in/<app_id>——后者没有 <webBase>/<login>.png（login 含 [bot]）。
    if (avatarUrl) return this.client.getBinary(avatarUrl);
    // 兜底（仅有 slug 时，如 ping 缓存的当前用户）：<webBase>/<login>.png?size=64
    return this.client.getBinary(`${this.webBase}/${encodeURIComponent(slug)}.png?size=64`);
  }

  async getAttachment(
    url: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    // GitHub 评论内嵌图片是绝对 URL（user-attachments / githubusercontent / GHE host）；
    // 经 main 端带 PAT 代理拉（私有需鉴权）。非绝对 / 失败 → null 让上层 fallback。
    return this.client.getBinary(url);
  }

  async publishInlineComment(
    repo: RepoRef,
    prId: string,
    anchor: PrCommentAnchor,
    body: string,
  ): Promise<PrComment> {
    const prefix = `/repos/${repo.projectKey}/${repo.repoSlug}`;
    // 行内评论需 commit_id = head sha；按 Phase 0 决策，adapter 内部拉 PR 取 head sha
    const pull = await this.client.get<GhPull>(`${prefix}/pulls/${prId}`);
    const created = await this.client.post<GhReviewComment>(`${prefix}/pulls/${prId}/comments`, {
      body,
      commit_id: pull.head.sha,
      path: anchor.path,
      line: anchor.line,
      side: anchor.side === 'old' ? 'LEFT' : 'RIGHT',
    });
    return mapReviewComment(created);
  }

  async replyToComment(
    repo: RepoRef,
    prId: string,
    parentCommentId: string,
    body: string,
  ): Promise<PrComment> {
    const prefix = `/repos/${repo.projectKey}/${repo.repoSlug}`;
    try {
      // 优先按 inline review-comment 回复
      const created = await this.client.post<GhReviewComment>(
        `${prefix}/pulls/${prId}/comments/${parentCommentId}/replies`,
        { body },
      );
      return mapReviewComment(created);
    } catch (e) {
      // 父评论是 summary（issue 评论，无线程）→ 退化为新建 issue 评论
      if (e instanceof GitHubClientError && (e.status === 404 || e.status === 422)) {
        const created = await this.client.post<GhIssueComment>(
          `${prefix}/issues/${prId}/comments`,
          { body },
        );
        return mapIssueComment(created);
      }
      throw e;
    }
  }

  async editComment(
    repo: RepoRef,
    _prId: string,
    commentId: string,
    _version: number,
    body: string,
  ): Promise<PrComment> {
    const prefix = `/repos/${repo.projectKey}/${repo.repoSlug}`;
    try {
      const updated = await this.client.patch<GhReviewComment>(
        `${prefix}/pulls/comments/${commentId}`,
        { body },
      );
      return mapReviewComment(updated);
    } catch (e) {
      if (e instanceof GitHubClientError && e.status === 404) {
        const updated = await this.client.patch<GhIssueComment>(
          `${prefix}/issues/comments/${commentId}`,
          { body },
        );
        return mapIssueComment(updated);
      }
      throw e;
    }
  }

  async deleteComment(
    repo: RepoRef,
    _prId: string,
    commentId: string,
    _version: number,
  ): Promise<void> {
    const prefix = `/repos/${repo.projectKey}/${repo.repoSlug}`;
    try {
      await this.client.del(`${prefix}/pulls/comments/${commentId}`);
    } catch (e) {
      if (e instanceof GitHubClientError && e.status === 404) {
        await this.client.del(`${prefix}/issues/comments/${commentId}`);
        return;
      }
      throw e;
    }
  }

  async setPullRequestReviewStatus(
    repo: RepoRef,
    prId: string,
    status: ReviewerStatus,
  ): Promise<void> {
    const prefix = `/repos/${repo.projectKey}/${repo.repoSlug}`;
    if (status === 'approved') {
      await this.client.post(`${prefix}/pulls/${prId}/reviews`, { event: 'APPROVE' });
      return;
    }
    if (status === 'needsWork') {
      // GitHub 要求 REQUEST_CHANGES 带 body
      await this.client.post(`${prefix}/pulls/${prId}/reviews`, {
        event: 'REQUEST_CHANGES',
        body: '需修改',
      });
      return;
    }
    // unapproved：撤销当前用户最近一条 APPROVED / CHANGES_REQUESTED 评审
    const me = this.cachedUser?.name;
    if (!me) return;
    const reviews = await collect(this.client.paginate<GhReview>(`${prefix}/pulls/${prId}/reviews`));
    const mine = reviews.filter(
      (r) =>
        r.user?.login === me && (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED'),
    );
    const latest = mine[mine.length - 1];
    if (latest) {
      await this.client.put(`${prefix}/pulls/${prId}/reviews/${String(latest.id)}/dismissals`, {
        message: '撤销评审意见',
      });
    }
  }

  async mergePullRequest(repo: RepoRef, prId: string): Promise<void> {
    // 合并失败（冲突 / 必评未过 / 无权限）→ client 抛 GitHubClientError 冒泡给上层
    await this.client.put(`/repos/${repo.projectKey}/${repo.repoSlug}/pulls/${prId}/merge`, {});
  }
}

// ---- 映射函数 ----

function parseRepositoryUrl(repositoryUrl: string): { owner: string; repo: string } {
  // https://api.github.com/repos/{owner}/{repo}
  const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(repositoryUrl);
  if (!m) throw new Error(`无法解析 repository_url: ${repositoryUrl}`);
  return { owner: m[1]!, repo: m[2]! };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

function mapUser(u: GhUser): PlatformUser {
  return { name: u.login, displayName: u.name ?? u.login, slug: u.login, avatarUrl: u.avatar_url };
}

function mapMergeStatus(p: GhPull): MergeStatus {
  const state = p.mergeable_state ?? 'unknown';
  const conflicted = p.mergeable === false || state === 'dirty';
  const vetoes: MergeVeto[] = [];
  if (conflicted) {
    vetoes.push({ summary: '存在合并冲突' });
  } else if (state === 'blocked') {
    vetoes.push({ summary: '被分支保护阻止（必需评审 / 检查未通过）' });
  } else if (state === 'behind') {
    vetoes.push({ summary: '落后于目标分支，需先更新分支' });
  } else if (state === 'unstable') {
    vetoes.push({ summary: '部分检查未通过' });
  } else if (p.mergeable == null || state === 'unknown') {
    vetoes.push({ summary: '可合并状态计算中…' });
  }
  return {
    canMerge: p.mergeable === true && state === 'clean',
    conflicted,
    vetoes,
  };
}

function buildReviewers(pull: GhPull, reviews: GhReview[]): Reviewer[] {
  const byLogin = new Map<string, Reviewer>();
  // 先放「已请求但未评审」的 reviewer（pending = unapproved）
  for (const u of pull.requested_reviewers ?? []) {
    byLogin.set(u.login, { ...mapUser(u), status: 'unapproved' });
  }
  // reviews 按时间升序，取每人最近一条「决断性」状态覆盖
  const sorted = [...reviews].sort((a, b) =>
    (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''),
  );
  for (const r of sorted) {
    if (!r.user) continue;
    let status: ReviewerStatus | null = null;
    if (r.state === 'APPROVED') status = 'approved';
    else if (r.state === 'CHANGES_REQUESTED') status = 'needsWork';
    else if (r.state === 'DISMISSED') status = 'unapproved';
    // COMMENTED / PENDING 不改变决断状态
    if (status) byLogin.set(r.user.login, { ...mapUser(r.user), status });
  }
  return [...byLogin.values()];
}

function mapPull(p: GhPull, reviewers: Reviewer[], mergeStatus: MergeStatus): PullRequest {
  const state: PullRequest['state'] = p.merged
    ? 'merged'
    : p.state === 'closed'
      ? 'declined'
      : 'open';
  return {
    remoteId: String(p.number),
    title: p.title,
    description: p.body ?? '',
    author: mapUser(p.user),
    state,
    draft: p.draft ?? false,
    sourceRef: { displayId: p.head.ref, sha: p.head.sha },
    targetRef: { displayId: p.base.ref, sha: p.base.sha },
    repo: {
      projectKey: p.base.repo?.owner.login ?? '',
      repoSlug: p.base.repo?.name ?? '',
    },
    url: p.html_url,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    reviewers,
    mergeStatus,
    hasConflict: mergeStatus.conflicted,
  };
}

function mapCommit(c: GhCommit): PrCommit {
  const authorName = c.commit.author?.name ?? c.author?.login ?? 'unknown';
  const committerName = c.commit.committer?.name ?? c.committer?.login ?? authorName;
  return {
    sha: c.sha,
    abbreviatedSha: c.sha.slice(0, 7),
    message: c.commit.message,
    author: { name: authorName, displayName: authorName, slug: c.author?.login },
    authoredAt: c.commit.author?.date ?? '',
    committer: { name: committerName, displayName: committerName, slug: c.committer?.login },
    committedAt: c.commit.committer?.date ?? '',
    parents: c.parents.map((p) => p.sha),
    url: c.html_url,
  };
}

function mapIssueComment(c: GhIssueComment): PrComment {
  return {
    remoteId: String(c.id),
    author: mapUser(c.user),
    body: c.body,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    anchor: null,
    replies: [],
    kind: 'summary',
    nativeId: String(c.id),
  };
}

function mapReviewComment(c: GhReviewComment): PrComment {
  const line = c.line ?? c.original_line ?? null;
  const anchor: PrCommentAnchor | null =
    line != null
      ? {
          path: c.path,
          line,
          side: c.side === 'LEFT' ? 'old' : 'new',
          // GitHub 不直接给 added/removed/context；按 side 取保守默认（仅展示用）
          lineType: c.side === 'LEFT' ? 'removed' : 'added',
        }
      : null;
  return {
    remoteId: String(c.id),
    author: mapUser(c.user),
    body: c.body,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    anchor,
    replies: [],
    kind: 'inline',
    threadId: String(c.id),
    nativeId: String(c.id),
  };
}
