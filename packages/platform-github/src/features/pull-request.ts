import type {
  ListPendingOptions,
  MergeStatus,
  PrActivityEvent,
  PrActivityKind,
  PrCommit,
  PrDiscoveryFilter,
  PullRequest,
  RepoRef,
  Reviewer,
  ReviewerStatus,
} from '@meebox/shared';
import {
  BasePullRequestService,
  collect,
  type ConnectionContext,
  type MergeVetoCode,
} from '@meebox/platform-core';
import type { GitHubClient } from '../client.js';
import { mapUser } from '../utils.js';
import type { GhCommit, GhPull, GhReview, GhSearchItem } from '../types.js';

/** 发现筛选分类 → GitHub search 主体限定词（对齐仪表盘四类）。 */
const FILTER_QUALIFIER: Record<PrDiscoveryFilter, string> = {
  'review-requested': 'review-requested:@me',
  created: 'author:@me',
  assigned: 'assignee:@me',
  mentioned: 'mentions:@me',
};

/** review 决断态 → 活动事件类型（COMMENTED / PENDING 非决断，不在表中 → 跳过）。 */
const ACTIVITY_KIND_BY_STATE: Partial<Record<GhReview['state'], PrActivityKind>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'needsWork',
  DISMISSED: 'dismissed',
};

/** review 决断态 → reviewer 状态（COMMENTED / PENDING 不改变决断态，不在表中）。 */
const REVIEWER_STATUS_BY_STATE: Partial<Record<GhReview['state'], ReviewerStatus>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'needsWork',
  DISMISSED: 'unapproved',
};

/** GitHub PR 操作领域：发现（search 两段取数）、提交、活动决断、审批、合并。 */
export class GitHubPullRequestService extends BasePullRequestService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: GitHubClient,
  ) {
    super(ctx);
  }

  /**
   * 发现待处理 PR：先经 search/issues 命中候选，再逐条取详情归一。
   *
   * 仅保留确为 PR 的命中；逐条详情请求并发执行，单条失败丢弃该条而不拖垮整体。
   */
  async listPendingPullRequests(opts?: ListPendingOptions): Promise<PullRequest[]> {
    const items: GhSearchItem[] = [];
    for await (const it of this.client.searchItems<GhSearchItem>('/search/issues', {
      q: this.discoveryQuery(opts?.filter ?? 'review-requested'),
    })) {
      if (it.pull_request) items.push(it);
    }
    // 每条命中再取 PR 详情（sha / mergeable / draft）+ reviews（reviewer 状态）。单个失败丢弃该条。
    const results = await Promise.allSettled(items.map((it) => this.loadPull(it)));
    return results
      .filter((r): r is PromiseFulfilledResult<PullRequest> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  /**
   * 按一条 search 命中加载完整 PR：并发取 PR 详情与 reviews，组装审批人与合并状态后归一。
   */
  private async loadPull(item: GhSearchItem): Promise<PullRequest> {
    const { owner, repo } = this.parseRepositoryUrl(item.repository_url);
    const base = `/repos/${owner}/${repo}/pulls/${String(item.number)}`;
    const [pull, reviews] = await Promise.all([
      this.client.get<GhPull>(base),
      collect(this.client.paginate<GhReview>(`${base}/reviews`)),
    ]);
    return this.mapPull(pull, this.buildReviewers(pull, reviews), this.mapMergeStatus(pull));
  }

  /**
   * 列出 PR 提交：GitHub 端点为 oldest-first，按契约反转为 newest-first 返回。
   */
  async listPullRequestCommits(repo: RepoRef, prId: string): Promise<PrCommit[]> {
    const out: PrCommit[] = [];
    for await (const c of this.client.paginate<GhCommit>(
      `/repos/${repo.projectKey}/${repo.repoSlug}/pulls/${prId}/commits`,
    )) {
      out.push(this.mapCommit(c));
    }
    // GitHub commits 是 oldest-first；契约要求 newest-first
    return out.reverse();
  }

  /**
   * 把 PR 的 reviews 提炼为评审决断活动事件。
   *
   * 仅保留有提交时间的决断态（APPROVED / CHANGES_REQUESTED / DISMISSED），COMMENTED / PENDING 跳过。
   */
  async listPullRequestActivity(repo: RepoRef, prId: string): Promise<PrActivityEvent[]> {
    const reviews = await collect(
      this.client.paginate<GhReview>(
        `/repos/${repo.projectKey}/${repo.repoSlug}/pulls/${prId}/reviews`,
      ),
    );
    const out: PrActivityEvent[] = [];
    for (const r of reviews) {
      // COMMENTED / PENDING 不是决断；submitted_at 缺失（草稿态）跳过
      if (!r.user || !r.submitted_at) continue;
      const kind = ACTIVITY_KIND_BY_STATE[r.state];
      if (!kind) continue;
      out.push({
        remoteId: String(r.id),
        kind,
        actor: mapUser(r.user),
        createdAt: r.submitted_at,
      });
    }
    return out;
  }

  /**
   * 写当前用户在 PR 上的 review 状态。
   *
   * approved / needsWork 各提交一条 review（REQUEST_CHANGES 需带 body）；unapproved 则撤销本人最近一条
   * 决断性评审（dismiss）。
   */
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
      // GitHub 要求 REQUEST_CHANGES 带 body（发往 GitHub 的内容，用英语中性文案）
      await this.client.post(`${prefix}/pulls/${prId}/reviews`, {
        event: 'REQUEST_CHANGES',
        body: 'Changes requested',
      });
      return;
    }
    // unapproved：撤销当前用户最近一条 APPROVED / CHANGES_REQUESTED 评审
    const me = this.ctx.getCurrentUser()?.name;
    if (!me) return;
    const reviews = await collect(
      this.client.paginate<GhReview>(`${prefix}/pulls/${prId}/reviews`),
    );
    const mine = reviews.filter(
      (r) => r.user?.login === me && (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED'),
    );
    const latest = mine[mine.length - 1];
    if (latest) {
      await this.client.put(`${prefix}/pulls/${prId}/reviews/${String(latest.id)}/dismissals`, {
        message: 'Dismissing review',
      });
    }
  }

  /**
   * 合并 PR（仅用 merge commit、不回退 squash/rebase）。
   *
   * 不可合并（禁用 merge commit / 冲突 / 必评必检未过 / 落后 / 无权限）时，GitHub 返回 405 或 403，
   * 错误经 client 携带响应体 message 冒泡给上层。
   */
  async mergePullRequest(repo: RepoRef, prId: string): Promise<void> {
    // 仅用 merge commit（空 body = 默认 merge_method=merge），不回退 squash/rebase。
    // 失败（仓库禁用 merge commit / 冲突 / 必评未过 / 必检未过 / 分支落后 / 无权限）→ GitHub 返回
    // 405「not mergeable」或 403，client 把响应体 message 带进 GitHubClientError 冒泡给上层。
    await this.client.put(`/repos/${repo.projectKey}/${repo.repoSlug}/pulls/${prId}/merge`, {});
  }

  // ---- 映射（领域私有）----

  /**
   * 按发现筛选分类拼出 search/issues 查询串（限定开放、非归档、PR 类型）。
   */
  private discoveryQuery(filter: PrDiscoveryFilter): string {
    return `is:open is:pr ${FILTER_QUALIFIER[filter]} archived:false`;
  }

  /**
   * 从 search 命中的 repository_url 解析出 owner / repo；无法解析则抛错。
   */
  private parseRepositoryUrl(repositoryUrl: string): { owner: string; repo: string } {
    // https://api.github.com/repos/{owner}/{repo}
    const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(repositoryUrl);
    if (!m) throw new Error(`Cannot parse repository_url: ${repositoryUrl}`);
    return { owner: m[1]!, repo: m[2]! };
  }

  /**
   * 把 GitHub 的 mergeable / mergeable_state 映射为统一合并状态。
   *
   * GitHub 否决信息仅 partial 保真，按 state 近似归类到单一否决码（冲突 / 受保护 / 落后 / 必检失败 /
   * 检测中）；canMerge 仅在 mergeable=true 且 state=clean 时为真。
   */
  private mapMergeStatus(p: GhPull): MergeStatus {
    const state = p.mergeable_state ?? 'unknown';
    const conflicted = p.mergeable === false || state === 'dirty';
    let code: MergeVetoCode | null = null;
    if (conflicted) code = 'conflict';
    else if (state === 'blocked') code = 'branchProtected';
    else if (state === 'behind') code = 'behind';
    else if (state === 'unstable') code = 'checksFailed';
    else if (p.mergeable == null || state === 'unknown') code = 'checking';
    return {
      canMerge: p.mergeable === true && state === 'clean',
      conflicted,
      vetoes: code ? [{ code }] : [],
    };
  }

  /**
   * 组装审批人列表：先以「已请求但未评审」者占位（unapproved），再按时间升序用每人最近一条决断态覆盖。
   */
  private buildReviewers(pull: GhPull, reviews: GhReview[]): Reviewer[] {
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
      const status = REVIEWER_STATUS_BY_STATE[r.state];
      if (status) byLogin.set(r.user.login, { ...mapUser(r.user), status });
    }
    return [...byLogin.values()];
  }

  /**
   * 把 GitHub PR 详情（含已组装的审批人与合并状态）归一为中性 PullRequest。
   *
   * 状态按 merged / closed / 其余映射为 merged / declined / open。
   */
  private mapPull(p: GhPull, reviewers: Reviewer[], mergeStatus: MergeStatus): PullRequest {
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

  /**
   * 把 GitHub 提交归一为中性 PrCommit；作者 / 提交者信息缺失时按 git 名→登录名→兜底逐级回退。
   */
  private mapCommit(c: GhCommit): PrCommit {
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
}
