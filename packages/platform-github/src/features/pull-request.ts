import type {
  ListPendingOptions,
  MergeStatus,
  MergeVeto,
  PrActivityEvent,
  PrActivityKind,
  PrCommit,
  PrDiscoveryFilter,
  PullRequest,
  RepoRef,
  Reviewer,
  ReviewerStatus,
} from '@meebox/shared';
import { BasePullRequestService, collect, type ConnectionContext } from '@meebox/platform-core';
import type { GitHubClient } from '../client.js';
import { mapUser } from '../mappers.js';
import type { GhCommit, GhPull, GhReview, GhSearchItem } from '../types.js';

/** 发现筛选分类 → GitHub search 主体限定词（对齐仪表盘四类）。 */
const FILTER_QUALIFIER: Record<PrDiscoveryFilter, string> = {
  'review-requested': 'review-requested:@me',
  created: 'author:@me',
  assigned: 'assignee:@me',
  mentioned: 'mentions:@me',
};

/** GitHub PR 操作领域：发现（search 两段取数）、提交、活动决断、审批、合并。 */
export class GitHubPullRequestService extends BasePullRequestService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: GitHubClient,
  ) {
    super(ctx);
  }

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

  private async loadPull(item: GhSearchItem): Promise<PullRequest> {
    const { owner, repo } = this.parseRepositoryUrl(item.repository_url);
    const base = `/repos/${owner}/${repo}/pulls/${String(item.number)}`;
    const [pull, reviews] = await Promise.all([
      this.client.get<GhPull>(base),
      collect(this.client.paginate<GhReview>(`${base}/reviews`)),
    ]);
    return this.mapPull(pull, this.buildReviewers(pull, reviews), this.mapMergeStatus(pull));
  }

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
      const kind: PrActivityKind | null =
        r.state === 'APPROVED'
          ? 'approved'
          : r.state === 'CHANGES_REQUESTED'
            ? 'needsWork'
            : r.state === 'DISMISSED'
              ? 'dismissed'
              : null;
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
        message: '撤销评审意见',
      });
    }
  }

  async mergePullRequest(repo: RepoRef, prId: string): Promise<void> {
    // 仅用 merge commit（空 body = 默认 merge_method=merge），不回退 squash/rebase。
    // 失败（仓库禁用 merge commit / 冲突 / 必评未过 / 必检未过 / 分支落后 / 无权限）→ GitHub 返回
    // 405「not mergeable」或 403，client 把响应体 message 带进 GitHubClientError 冒泡给上层。
    await this.client.put(`/repos/${repo.projectKey}/${repo.repoSlug}/pulls/${prId}/merge`, {});
  }

  // ---- 映射（领域私有）----

  private discoveryQuery(filter: PrDiscoveryFilter): string {
    return `is:open is:pr ${FILTER_QUALIFIER[filter]} archived:false`;
  }

  private parseRepositoryUrl(repositoryUrl: string): { owner: string; repo: string } {
    // https://api.github.com/repos/{owner}/{repo}
    const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(repositoryUrl);
    if (!m) throw new Error(`Cannot parse repository_url: ${repositoryUrl}`);
    return { owner: m[1]!, repo: m[2]! };
  }

  private mapMergeStatus(p: GhPull): MergeStatus {
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
      let status: ReviewerStatus | null = null;
      if (r.state === 'APPROVED') status = 'approved';
      else if (r.state === 'CHANGES_REQUESTED') status = 'needsWork';
      else if (r.state === 'DISMISSED') status = 'unapproved';
      // COMMENTED / PENDING 不改变决断状态
      if (status) byLogin.set(r.user.login, { ...mapUser(r.user), status });
    }
    return [...byLogin.values()];
  }

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
