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

/** GitLab PR operations domain: discovery (three filter categories), commits, approval, merge. GitLab provides no activity timeline events. */
export class GitLabPullRequestService extends BasePullRequestService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: GitLabClient,
  ) {
    super(ctx);
  }

  /**
   * Discover pending MRs: scope=all paginates globally across projects, then fetch and normalize details one by one.
   *
   * Without a ping (no current user) the query can't be built, so return empty directly; per-item details run concurrently, and a single failure discards that item.
   */
  async listPendingPullRequests(opts?: ListPendingOptions): Promise<PullRequest[]> {
    const me = this.ctx.getCurrentUser()?.name;
    // scope=all is global across projects; switch reviewer/author/assignee scoping by filter (defaults to awaiting my review).
    // Without a ping (no me) it can't be built → empty.
    if (!me) return [];
    const items: GlMr[] = [];
    for await (const mr of this.client.paginate<GlMr>(
      '/merge_requests',
      this.discoveryParams(opts?.filter ?? 'review-requested', me),
    )) {
      items.push(mr);
    }
    // For each, fetch details (diff_refs / detailed_merge_status) + approval (approved_by). A single failure discards that item.
    const results = await Promise.allSettled(items.map((mr) => this.loadMr(mr)));
    return results
      .filter((r): r is PromiseFulfilledResult<PullRequest> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  /**
   * Load a full MR from a single MR list item: fetch details, and when approval is available fetch approved_by, assemble approvers, then normalize.
   *
   * When the approval endpoint is unavailable due to tier / permissions, treat it as nobody having approved.
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
        /* approval unavailable (tier/permissions) → treat as nobody approved */
      }
    }
    return this.mapMr(detail, repo, this.buildReviewers(detail, approvedUsers));
  }

  /** Fetch a single MR from the remote by repo + iid (reusing loadMr's assembly); 404 / 403 are thrown by the client for the caller to normalize. */
  async getSinglePullRequest(repo: RepoRef, prId: string): Promise<PullRequest> {
    const base = `/projects/${projectId(repo)}/merge_requests/${prId}`;
    const detail = await this.client.get<GlMr>(base);
    let approvedUsers: GlUser[] = [];
    if (this.client.approvalsAvailable) {
      try {
        const approvals = await this.client.get<GlApprovals>(`${base}/approvals`);
        approvedUsers = (approvals.approved_by ?? []).map((a) => a.user);
      } catch {
        /* approval unavailable (tier/permissions) → treat as nobody approved */
      }
    }
    return this.mapMr(detail, repo, this.buildReviewers(detail, approvedUsers));
  }

  /**
   * List MR commits: the GitLab endpoint is already newest-first, consistent with the contract, no reversal needed.
   */
  async listPullRequestCommits(repo: RepoRef, prId: string): Promise<PrCommit[]> {
    const out: PrCommit[] = [];
    for await (const c of this.client.paginate<GlCommit>(
      `/projects/${projectId(repo)}/merge_requests/${prId}/commits`,
    )) {
      out.push(this.mapCommit(c));
    }
    // The GitLab MR commits endpoint is already reverse-chronological (newest-first), matching the contract, no reversal needed.
    return out;
  }

  /**
   * GitLab does not participate in the activity timeline (capabilities.activityTimeline=false): no reliable unified decision event source, always returns empty.
   */
  async listPullRequestActivity(_repo: RepoRef, _prId: string): Promise<PrActivityEvent[]> {
    // Differentiated design: GitLab does not participate in the activity timeline (capabilities.activityTimeline=false, the PR tab degrades to a pure
    // comment view), so no decision events are needed. GitLab also has no unified activity event source—CE has no approval, and approval is only reflected in fragile English
    // system notes, not on par with the reliable timestamped events of Bitbucket /activities or GitHub /reviews—return empty.
    return [];
  }

  /**
   * Write the current user's review status: approved / unapproved hit the approve / unapprove endpoints respectively.
   *
   * GitLab has no "request changes" concept, needsWork won't be triggered by the UI, defensively throw.
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
    // needsWork: GitLab has no "request changes" concept. capabilities.reviewStatuses doesn't include needsWork,
    // the UI won't trigger it; defensively throw.
    throw new Error('GitLab does not support the "request changes" review status');
  }

  /**
   * Merge an MR (squash / ff decided by repo settings).
   *
   * When not mergeable (conflict / unapproved / pipeline not passing / no permission), GitLab returns 405/406/409, and the error bubbles up carrying the message.
   */
  async mergePullRequest(repo: RepoRef, prId: string): Promise<void> {
    // PUT /merge: squash/ff decided by repo settings. Failure (conflict / unapproved / pipeline not passing / permission) → 405/406/409 with message.
    await this.client.put(`/projects/${projectId(repo)}/merge_requests/${prId}/merge`, {});
  }

  // ---- Mapping (domain-private) ----

  /**
   * Map a discovery filter category to /merge_requests query params (scope=all global, scoped by role).
   *
   * GitLab has no "mentioned" concept, so that category degrades to "awaiting my review".
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
   * Parse the project path from an MR web_url: `https://host/<group>/<sub>/<project>/-/merge_requests/<iid>`
   * → projectKey=`group/sub` (nested namespace), repoSlug=`project`.
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
   * Map GitLab detailed_merge_status to a unified veto reason code.
   *
   * The backend doesn't assemble localized text; the frontend does i18n by code; unrecognized statuses fall under notMergeable.
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
   * Map a GitLab MR's merge state to a unified MergeStatus (full fidelity).
   *
   * With detailed_merge_status, determine canMerge and veto codes from it (unsubdivided reasons keep the raw string in detail for troubleshooting);
   * when old instances lack this field, fall back to the merge_status approximation.
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
        // Unsubdivided reason (default) keeps the raw dms in detail for troubleshooting
        vetoes.push(code === 'notMergeable' ? { code, detail: dms } : { code });
      }
    } else {
      // Old instances lack detailed_merge_status: fall back to merge_status.
      canMerge = mr.merge_status === 'can_be_merged' && !conflicted;
      if (conflicted) vetoes.push({ code: 'conflict' });
      else if (mr.merge_status === 'cannot_be_merged') vetoes.push({ code: 'notMergeable' });
      else if (mr.merge_status === 'checking' || mr.merge_status === 'unchecked')
        vetoes.push({ code: 'checking' });
    }
    return { canMerge, conflicted, vetoes };
  }

  /**
   * Assemble the approver list: first placeholder the assigned reviewers (unapproved), then override / supplement to approved with approved_by.
   */
  private buildReviewers(mr: GlMr, approvedUsers: GlUser[]): Reviewer[] {
    const byUser = new Map<string, Reviewer>();
    // First add the assigned reviewers (unapproved by default).
    for (const u of mr.reviewers ?? []) {
      byUser.set(u.username, { ...mapUser(u), status: 'unapproved' });
    }
    // approved_by overrides / supplements to approved (including people not in the reviewers list but who have approved).
    for (const u of approvedUsers) {
      byUser.set(u.username, { ...mapUser(u), status: 'approved' });
    }
    return [...byUser.values()];
  }

  /**
   * Normalize GitLab MR details (with assembled approvers) into a neutral PullRequest.
   *
   * State maps merged / opened / others to merged / open / declined; source/target sha prefer diff_refs.
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
      // User note count (system notes excluded, replies are also notes) → includes replies (capabilities marks true).
      commentCount: mr.user_notes_count,
    };
  }

  /**
   * Normalize a GitLab commit into a neutral PrCommit; when fields are missing, fall back step by step to git name / short sha / title, etc.
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
