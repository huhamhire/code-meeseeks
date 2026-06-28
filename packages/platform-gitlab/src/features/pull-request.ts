import type {
  ListPendingOptions,
  MergeStatus,
  MergeVeto,
  PrActivityEvent,
  PrCommit,
  PrDiscoveryFilter,
  PullRequest,
  RepoRef,
  Reviewer,
  ReviewerStatus,
} from '@meebox/shared';
import {
  BasePullRequestService,
  type ConnectionContext,
  type MergeVetoCode,
} from '@meebox/platform-core';
import type { GitLabClient } from '../client.js';
import { mapUser, projectId } from '../utils.js';
import type { GlApprovals, GlCommit, GlMr, GlUser } from '../types.js';

/** GitLab PR 操作领域：发现（三类筛选）、提交、审批、合并。GitLab 不提供活动时间线事件。 */
export class GitLabPullRequestService extends BasePullRequestService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: GitLabClient,
  ) {
    super(ctx);
  }

  /**
   * 发现待处理 MR：scope=all 全局跨项目分页命中后逐条取详情归一。
   *
   * 未 ping（无当前用户）则无法构造查询，直接返回空；逐条详情并发执行，单条失败丢弃该条。
   */
  async listPendingPullRequests(opts?: ListPendingOptions): Promise<PullRequest[]> {
    const me = this.ctx.getCurrentUser()?.name;
    // scope=all 全局跨项目；按 filter 切换 reviewer/author/assignee 限定（默认待我评审）。
    // 未 ping（无 me）则无法构造 → 空。
    if (!me) return [];
    const items: GlMr[] = [];
    for await (const mr of this.client.paginate<GlMr>(
      '/merge_requests',
      this.discoveryParams(opts?.filter ?? 'review-requested', me),
    )) {
      items.push(mr);
    }
    // 每条再取详情（diff_refs / detailed_merge_status）+ 审批（approved_by）。单个失败丢弃该条。
    const results = await Promise.allSettled(items.map((mr) => this.loadMr(mr)));
    return results
      .filter((r): r is PromiseFulfilledResult<PullRequest> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  /**
   * 按一条 MR 列表项加载完整 MR：取详情，审批可用时再取 approved_by，组装审批人后归一。
   *
   * 审批端点因 tier / 权限不可用时按无人 approve 处理。
   */
  private async loadMr(listItem: GlMr): Promise<PullRequest> {
    const repo = this.parseProjectPath(listItem.web_url);
    const base = `/projects/${String(listItem.project_id)}/merge_requests/${String(listItem.iid)}`;
    const detail = await this.client.get<GlMr>(base);
    let approvedUsers: GlUser[] = [];
    if (this.client.approvalsAvailable) {
      try {
        const approvals = await this.client.get<GlApprovals>(`${base}/approvals`);
        approvedUsers = (approvals.approved_by ?? []).map((a) => a.user);
      } catch {
        /* 审批不可用（tier/权限）→ 视作无人 approve */
      }
    }
    return this.mapMr(detail, repo, this.buildReviewers(detail, approvedUsers));
  }

  /** 按 repo + iid 从远端拉单个 MR（复用 loadMr 同款组装）；404 / 403 由 client 抛出供上层归一。 */
  async getSinglePullRequest(repo: RepoRef, prId: string): Promise<PullRequest> {
    const base = `/projects/${projectId(repo)}/merge_requests/${prId}`;
    const detail = await this.client.get<GlMr>(base);
    let approvedUsers: GlUser[] = [];
    if (this.client.approvalsAvailable) {
      try {
        const approvals = await this.client.get<GlApprovals>(`${base}/approvals`);
        approvedUsers = (approvals.approved_by ?? []).map((a) => a.user);
      } catch {
        /* 审批不可用（tier/权限）→ 视作无人 approve */
      }
    }
    return this.mapMr(detail, repo, this.buildReviewers(detail, approvedUsers));
  }

  /**
   * 列出 MR 提交：GitLab 端点已是 newest-first，与契约一致，无需反转。
   */
  async listPullRequestCommits(repo: RepoRef, prId: string): Promise<PrCommit[]> {
    const out: PrCommit[] = [];
    for await (const c of this.client.paginate<GlCommit>(
      `/projects/${projectId(repo)}/merge_requests/${prId}/commits`,
    )) {
      out.push(this.mapCommit(c));
    }
    // GitLab MR commits 端点已是 reverse-chronological（newest-first），契约同要求，无需反转。
    return out;
  }

  /**
   * GitLab 不参与活动时间线（capabilities.activityTimeline=false）：无可靠的统一决断事件源，恒返回空。
   */
  async listPullRequestActivity(_repo: RepoRef, _prId: string): Promise<PrActivityEvent[]> {
    // 差异化设计：GitLab 不参与活动时间线（capabilities.activityTimeline=false，PR 标签页退化为纯
    // 评论视图），故无需提供决断事件。GitLab 也没有统一活动事件源——CE 无审批、审批仅以脆弱的英文
    // 系统 note 体现，与 Bitbucket /activities、GitHub /reviews 的可靠时间戳事件不对等——返回空。
    return [];
  }

  /**
   * 写当前用户的 review 状态：approved / unapproved 分别打 approve / unapprove 端点。
   *
   * GitLab 无 "request changes" 概念，needsWork 不会被 UI 触发，防御性抛错。
   */
  async setPullRequestReviewStatus(
    repo: RepoRef,
    prId: string,
    status: ReviewerStatus,
  ): Promise<void> {
    const base = `/projects/${projectId(repo)}/merge_requests/${prId}`;
    if (status === 'approved') {
      await this.client.post(`${base}/approve`, {});
      return;
    }
    if (status === 'unapproved') {
      await this.client.post(`${base}/unapprove`, {});
      return;
    }
    // needsWork：GitLab 无 "request changes" 概念。capabilities.reviewStatuses 不含 needsWork，
    // UI 不会触发；防御性抛错。
    throw new Error('GitLab does not support the "request changes" review status');
  }

  /**
   * 合并 MR（squash / ff 由仓库设置决定）。
   *
   * 不可合并（冲突 / 未批 / 流水线未过 / 无权限）时 GitLab 返回 405/406/409，错误携带 message 冒泡。
   */
  async mergePullRequest(repo: RepoRef, prId: string): Promise<void> {
    // PUT /merge：squash/ff 由仓库设置决定。失败（冲突 / 未批 / 流水线未过 / 权限）→ 405/406/409 带 message。
    await this.client.put(`/projects/${projectId(repo)}/merge_requests/${prId}/merge`, {});
  }

  // ---- 映射（领域私有）----

  /**
   * 把发现筛选分类映射为 /merge_requests 查询参数（scope=all 全局，按角色限定）。
   *
   * GitLab 无 "mentioned" 概念，该分类退化为「待我评审」。
   */
  private discoveryParams(filter: PrDiscoveryFilter, me: string): Record<string, string> {
    const base = { scope: 'all', state: 'opened' };
    switch (filter) {
      case 'created':
        return { ...base, author_username: me };
      case 'assigned':
        return { ...base, assignee_username: me };
      case 'review-requested':
      case 'mentioned':
      default:
        return { ...base, reviewer_username: me };
    }
  }

  /**
   * 从 MR web_url 解析项目路径：`https://host/<group>/<sub>/<project>/-/merge_requests/<iid>`
   * → projectKey=`group/sub`（嵌套 namespace），repoSlug=`project`。
   */
  private parseProjectPath(webUrl: string): RepoRef {
    let pathname: string;
    try {
      pathname = new URL(webUrl).pathname;
    } catch {
      pathname = webUrl;
    }
    const idx = pathname.indexOf('/-/');
    const full = (idx >= 0 ? pathname.slice(0, idx) : pathname).replace(/^\/+|\/+$/g, '');
    const segs = full.split('/');
    const repoSlug = segs.pop() ?? '';
    return { projectKey: segs.join('/'), repoSlug };
  }

  /**
   * 把 GitLab detailed_merge_status 映射为统一否决原因码。
   *
   * 后台不拼本地化文案，由前端按码做 i18n；未识别的状态归为 notMergeable。
   */
  private mergeStatusCode(dms: string): MergeVetoCode {
    switch (dms) {
      case 'broken_status':
      case 'conflict':
        return 'conflict';
      case 'draft_status':
        return 'draft';
      case 'discussions_not_resolved':
        return 'discussionsUnresolved';
      case 'ci_must_pass':
      case 'ci_still_running':
        return 'checksFailed';
      case 'not_approved':
      case 'requested_changes':
        return 'notApproved';
      case 'need_rebase':
        return 'behind';
      case 'not_open':
        return 'notOpen';
      case 'blocked_status':
        return 'blockedByDependency';
      case 'preparing':
      case 'checking':
      case 'unchecked':
        return 'checking';
      default:
        return 'notMergeable';
    }
  }

  /**
   * 把 GitLab MR 的合并状态映射为统一 MergeStatus（full 保真）。
   *
   * 有 detailed_merge_status 时按其判定 canMerge 与否决码（未细分原因保留原始串到 detail 便于排障）；
   * 旧实例缺该字段时退回 merge_status 近似。
   */
  private mapMergeStatus(mr: GlMr): MergeStatus {
    const dms = mr.detailed_merge_status;
    const conflicted = mr.has_conflicts === true || dms === 'broken_status' || dms === 'conflict';
    const vetoes: MergeVeto[] = [];
    let canMerge: boolean;
    if (dms) {
      canMerge = dms === 'mergeable';
      if (!canMerge) {
        const code = this.mergeStatusCode(dms);
        // 未细分原因（default）保留原始 dms 到 detail，便于排障
        vetoes.push(code === 'notMergeable' ? { code, detail: dms } : { code });
      }
    } else {
      // 旧实例无 detailed_merge_status：退 merge_status。
      canMerge = mr.merge_status === 'can_be_merged' && !conflicted;
      if (conflicted) vetoes.push({ code: 'conflict' });
      else if (mr.merge_status === 'cannot_be_merged') vetoes.push({ code: 'notMergeable' });
      else if (mr.merge_status === 'checking' || mr.merge_status === 'unchecked')
        vetoes.push({ code: 'checking' });
    }
    return { canMerge, conflicted, vetoes };
  }

  /**
   * 组装审批人列表：先以指派的 reviewer 占位（unapproved），再用 approved_by 覆盖 / 补充为 approved。
   */
  private buildReviewers(mr: GlMr, approvedUsers: GlUser[]): Reviewer[] {
    const byUser = new Map<string, Reviewer>();
    // 先放指派的 reviewer（默认未批）。
    for (const u of mr.reviewers ?? []) {
      byUser.set(u.username, { ...mapUser(u), status: 'unapproved' });
    }
    // approved_by 覆盖 / 补充为 approved（含未在 reviewers 列表但已批的人）。
    for (const u of approvedUsers) {
      byUser.set(u.username, { ...mapUser(u), status: 'approved' });
    }
    return [...byUser.values()];
  }

  /**
   * 把 GitLab MR 详情（含已组装的审批人）归一为中性 PullRequest。
   *
   * 状态按 merged / opened / 其余映射为 merged / open / declined；source/target sha 优先取 diff_refs。
   */
  private mapMr(mr: GlMr, repo: RepoRef, reviewers: Reviewer[]): PullRequest {
    const state: PullRequest['state'] =
      mr.state === 'merged' ? 'merged' : mr.state === 'opened' ? 'open' : 'declined';
    const mergeStatus = this.mapMergeStatus(mr);
    return {
      remoteId: String(mr.iid),
      title: mr.title,
      description: mr.description ?? '',
      author: mapUser(mr.author),
      state,
      draft: mr.draft ?? mr.work_in_progress ?? false,
      sourceRef: { displayId: mr.source_branch, sha: mr.diff_refs?.head_sha ?? mr.sha ?? '' },
      targetRef: { displayId: mr.target_branch, sha: mr.diff_refs?.base_sha ?? '' },
      repo,
      url: mr.web_url,
      createdAt: mr.created_at,
      updatedAt: mr.updated_at,
      reviewers,
      mergeStatus,
      hasConflict: mergeStatus.conflicted,
    };
  }

  /**
   * 把 GitLab 提交归一为中性 PrCommit；缺字段时按 git 名 / 短 sha / 标题等逐级回退。
   */
  private mapCommit(c: GlCommit): PrCommit {
    const authorName = c.author_name ?? 'unknown';
    const committerName = c.committer_name ?? authorName;
    return {
      sha: c.id,
      abbreviatedSha: c.short_id ?? c.id.slice(0, 8),
      message: c.message ?? c.title ?? '',
      author: { name: authorName, displayName: authorName },
      authoredAt: c.authored_date ?? '',
      committer: { name: committerName, displayName: committerName },
      committedAt: c.committed_date ?? c.authored_date ?? '',
      parents: c.parent_ids ?? [],
      url: c.web_url,
    };
  }
}
