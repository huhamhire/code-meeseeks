import {
  AppError,
  ERROR_CODES,
  type ListPendingOptions,
  type MergeStatus,
  type PlatformUser,
  type PrActivityEvent,
  type PrActivityKind,
  type PrCommit,
  type PullRequest,
  type RepoRef,
  type Reviewer,
  type ReviewerStatus,
} from '@meebox/shared';
import { BasePullRequestService, type ConnectionContext } from '@meebox/platform-core';
import { BitbucketClientError, type BitbucketClient } from '../client.js';
import { mapUser } from '../utils.js';
import type {
  BitbucketActivity,
  BitbucketCommit,
  BitbucketMergeStatus,
  BitbucketParticipant,
  BitbucketPullRequest,
} from '../types.js';

/** Bitbucket 活动 action → 评审决断事件类型（仅决断类，其余 action 不在表中 → 跳过）。 */
const ACTIVITY_KIND_BY_ACTION: Record<string, PrActivityKind> = {
  APPROVED: 'approved',
  UNAPPROVED: 'unapproved',
  REVIEWED: 'needsWork',
};

/** Bitbucket participant.status → 中性 reviewer 状态（缺省时退回 approved 布尔，见 mapReviewer）。 */
const REVIEWER_STATUS_BY_STATUS: Partial<
  Record<NonNullable<BitbucketParticipant['status']>, ReviewerStatus>
> = {
  APPROVED: 'approved',
  NEEDS_WORK: 'needsWork',
  UNAPPROVED: 'unapproved',
};

/** 中性 review 状态 → Bitbucket participant status（写审批用）。 */
const BB_STATUS_BY_REVIEW: Record<ReviewerStatus, string> = {
  approved: 'APPROVED',
  needsWork: 'NEEDS_WORK',
  unapproved: 'UNAPPROVED',
};

/** Bitbucket PR 操作领域：dashboard 发现、提交、活动决断、审批、合并。 */
export class BitbucketPullRequestService extends BasePullRequestService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: BitbucketClient,
  ) {
    super(ctx);
  }

  /**
   * dashboard 聚合发现待处理 PR，并并行拉每个 PR 的 /merge 状态归一可合并性。
   *
   * 发现分类 → dashboard role：created=我创建(AUTHOR)，其余(待我评审)=REVIEWER。单个 /merge 失败
   * 降级为「无已知阻塞」（canMerge=true / 无冲突 / 无 vetoes），与原 hasConflict 失败降级语义一致。
   */
  async listPendingPullRequests(opts?: ListPendingOptions): Promise<PullRequest[]> {
    const role = opts?.filter === 'created' ? 'AUTHOR' : 'REVIEWER';
    const bitbucketPrs: BitbucketPullRequest[] = [];
    for await (const pr of this.client.paginate<BitbucketPullRequest>(
      '/rest/api/1.0/dashboard/pull-requests',
      { role, state: 'OPEN' },
    )) {
      bitbucketPrs.push(pr);
    }

    const mergeResults = await Promise.allSettled(
      bitbucketPrs.map((pr) => this.fetchMergeStatus(pr)),
    );

    return bitbucketPrs.map((pr, i) => {
      const result = mergeResults[i]!;
      const mergeStatus =
        result.status === 'fulfilled'
          ? this.mapMergeStatus(result.value)
          : { canMerge: true, conflicted: false, vetoes: [] };
      return this.mapPullRequest(pr, mergeStatus);
    });
  }

  /** 按 repo + 号从远端拉单个 PR（详情 + /merge 状态，复用映射）；404 / 403 由 client 抛出供上层归一。 */
  async getSinglePullRequest(repo: RepoRef, prId: string): Promise<PullRequest> {
    const base = `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}`;
    const pr = await this.client.get<BitbucketPullRequest>(base);
    return this.mapPullRequest(pr, this.mapMergeStatus(await this.fetchMergeStatus(pr)));
  }

  /**
   * 列出 PR 全部提交（newest-first，与 git log 一致）。
   *
   * 一次性收集分页结果——PR 通常仅数十个 commit，不分页问题不大。
   */
  async listPullRequestCommits(repo: RepoRef, prId: string): Promise<PrCommit[]> {
    const out: PrCommit[] = [];
    for await (const c of this.client.paginate<BitbucketCommit>(
      `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/commits`,
    )) {
      out.push(this.mapBitbucketCommit(c, repo));
    }
    return out;
  }

  /**
   * 从 /activities 流里挑出评审决断事件（APPROVED / UNAPPROVED / REVIEWED=标记 Needs Work）。
   *
   * 评论（COMMENTED）走评论领域，这里只取决断；非决断 action 跳过。
   */
  async listPullRequestActivity(repo: RepoRef, prId: string): Promise<PrActivityEvent[]> {
    const out: PrActivityEvent[] = [];
    for await (const activity of this.client.paginate<BitbucketActivity>(
      `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/activities`,
    )) {
      const kind = ACTIVITY_KIND_BY_ACTION[activity.action];
      if (!kind) continue;
      out.push({
        remoteId: String(activity.id),
        kind,
        actor: mapUser(activity.user),
        createdAt: new Date(activity.createdDate).toISOString(),
      });
    }
    return out;
  }

  /**
   * 把当前 PAT 用户在 PR 上的 review 状态写到远端（PUT participants/{userSlug}）。
   *
   * 需 ping() 已落地当前用户（取 slug + name 构造端点与 body），否则抛错。
   */
  async setPullRequestReviewStatus(
    repo: RepoRef,
    prId: string,
    status: ReviewerStatus,
  ): Promise<void> {
    const me = this.ctx.getCurrentUser();
    if (!me) {
      throw new Error(
        'setPullRequestReviewStatus: current user unknown — ping() not called or failed',
      );
    }
    const slug = me.slug ?? me.name;
    await this.client.put(
      `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/participants/${encodeURIComponent(slug)}`,
      { status: BB_STATUS_BY_REVIEW[status], user: { name: me.name } },
    );
  }

  /**
   * 合并 PR：先拉最新 PR 取 version（乐观锁）再 POST /merge?version=N。
   *
   * 已合并（他人已合 / 重复点击）回 409 + IllegalPullRequestStateException → 归一成
   * PR_ALREADY_MERGED 错误码供前端 i18n；其它 409（冲突 / veto / 无权限）原样冒泡。
   */
  async mergePullRequest(repo: RepoRef, prId: string): Promise<void> {
    const base = `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}`;
    const pr = await this.client.get<BitbucketPullRequest>(base);
    try {
      await this.client.post(`${base}/merge?version=${String(pr.version)}`, {});
    } catch (err) {
      if (this.isAlreadyMergedError(err)) {
        throw new AppError(ERROR_CODES.PR_ALREADY_MERGED, undefined, 'pull request already merged');
      }
      throw err;
    }
  }

  // ---- 映射（领域私有）----

  /** 拉单个 PR 的 /merge 状态（canMerge / conflicted / vetoes 同源一次拉全）。 */
  private async fetchMergeStatus(pr: BitbucketPullRequest): Promise<BitbucketMergeStatus> {
    const project = pr.toRef.repository.project.key;
    const repo = pr.toRef.repository.slug;
    return this.client.get<BitbucketMergeStatus>(
      `/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests/${String(pr.id)}/merge`,
    );
  }

  /** Bitbucket `/merge` 响应 → 中性 MergeStatus；vetoes 由服务端直给文案，缺省归一成空数组。 */
  private mapMergeStatus(bb: BitbucketMergeStatus): MergeStatus {
    return {
      canMerge: bb.canMerge,
      conflicted: bb.conflicted,
      vetoes: (bb.vetoes ?? []).map((v) => ({
        summary: v.summaryMessage,
        detail: v.detailedMessage,
      })),
    };
  }

  /** Bitbucket participant → 中性 Reviewer；status（7.x+）缺省时退回 approved 布尔。 */
  private mapReviewer(p: BitbucketParticipant): Reviewer {
    const mapped = p.status ? REVIEWER_STATUS_BY_STATUS[p.status] : undefined;
    const status: ReviewerStatus = mapped ?? (p.approved ? 'approved' : 'unapproved');
    return { ...mapUser(p.user), status };
  }

  /** Bitbucket PR → 中性 PullRequest；hasConflict 为 mergeStatus.conflicted 的派生镜像。 */
  private mapPullRequest(bb: BitbucketPullRequest, mergeStatus: MergeStatus): PullRequest {
    const url = bb.links.self[0]?.href ?? '';
    const targetRepo = bb.toRef.repository;
    return {
      remoteId: String(bb.id),
      title: bb.title,
      description: bb.description ?? '',
      author: mapUser(bb.author.user),
      state: bb.state.toLowerCase() as PullRequest['state'],
      draft: bb.draft ?? false,
      sourceRef: { displayId: bb.fromRef.displayId, sha: bb.fromRef.latestCommit },
      targetRef: { displayId: bb.toRef.displayId, sha: bb.toRef.latestCommit },
      repo: { projectKey: targetRepo.project.key, repoSlug: targetRepo.slug },
      url,
      createdAt: new Date(bb.createdDate).toISOString(),
      updatedAt: new Date(bb.updatedDate).toISOString(),
      reviewers: bb.reviewers.map((r) => this.mapReviewer(r)),
      mergeStatus,
      hasConflict: mergeStatus.conflicted,
    };
  }

  /** Bitbucket commit → 中性 PrCommit，附 commit 详情页 URL。 */
  private mapBitbucketCommit(c: BitbucketCommit, repo: RepoRef): PrCommit {
    const url = `${this.client.webBase}/projects/${repo.projectKey}/repos/${repo.repoSlug}/commits/${c.id}`;
    return {
      sha: c.id,
      abbreviatedSha: c.displayId,
      message: c.message,
      author: this.committerToUser(c.author),
      authoredAt: new Date(c.authorTimestamp).toISOString(),
      committer: this.committerToUser(c.committer),
      committedAt: new Date(c.committerTimestamp).toISOString(),
      parents: c.parents.map((p) => p.id),
      url,
    };
  }

  /**
   * Bitbucket commit 的 author/committer 只给 name（含 email），无 slug / displayName。
   *
   * 这里把 name 同时当 name + displayName，slug 留空（UI 头像 fallback 到 initials），email 暂丢弃。
   */
  private committerToUser(c: { name: string; emailAddress?: string }): PlatformUser {
    return { name: c.name, displayName: c.name };
  }

  /**
   * 判断错误是否为「PR 已被合并」：Bitbucket 对已合并 / 已关闭 PR 的合并请求回 409 +
   * IllegalPullRequestStateException，错误体含「already … merged」。其它 409（冲突 / veto / 无权限）不在此列。
   */
  private isAlreadyMergedError(err: unknown): boolean {
    if (!(err instanceof BitbucketClientError) || err.status !== 409) return false;
    const body = err.body.toLowerCase();
    return body.includes('illegalpullrequeststateexception') && body.includes('merged');
  }
}
