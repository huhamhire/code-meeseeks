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

/** Discovery filter category → GitHub search body qualifier (aligned with the dashboard's four categories). */
const FILTER_QUALIFIER: Record<PrDiscoveryFilter, string> = {
  'review-requested': 'review-requested:@me',
  created: 'author:@me',
  assigned: 'assignee:@me',
  mentioned: 'mentions:@me',
};

/** review decision state → activity event kind (COMMENTED / PENDING are non-decisions, not in the table → skipped). */
const ACTIVITY_KIND_BY_STATE: Partial<Record<GhReview['state'], PrActivityKind>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'needsWork',
  DISMISSED: 'dismissed',
};

/** review decision state → reviewer status (COMMENTED / PENDING do not change the decision state, not in the table). */
const REVIEWER_STATUS_BY_STATE: Partial<Record<GhReview['state'], ReviewerStatus>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'needsWork',
  DISMISSED: 'unapproved',
};

/** GitHub PR operations domain: discovery (search two-stage fetch), commits, activity decisions, approval, merge. */
export class GitHubPullRequestService extends BasePullRequestService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: GitHubClient,
  ) {
    super(ctx);
  }

  /**
   * Discover pending PRs: first hit candidates via search/issues, then fetch details per item and normalize.
   *
   * Only hits confirmed to be PRs are kept; per-item detail requests run concurrently, a single failure discards that item without dragging down the whole.
   */
  async listPendingPullRequests(opts?: ListPendingOptions): Promise<PullRequest[]> {
    const items: GhSearchItem[] = [];
    for await (const it of this.client.searchItems<GhSearchItem>('/search/issues', {
      q: this.discoveryQuery(opts?.filter ?? 'review-requested'),
    })) {
      if (it.pull_request) items.push(it);
    }
    // For each hit, fetch PR details (sha / mergeable / draft) + reviews (reviewer status). A single failure discards that item.
    const results = await Promise.allSettled(items.map((it) => this.loadPull(it)));
    return results
      .filter((r): r is PromiseFulfilledResult<PullRequest> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  /**
   * Load the full PR from a single search hit: concurrently fetch PR details and reviews, assemble reviewers and merge status, then normalize.
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

  /** Fetch a single PR from the remote by repo + number (reuses the same assembly as loadPull); 404 / 403 are thrown by the client for the upper layer to normalize. */
  async getSinglePullRequest(repo: RepoRef, prId: string): Promise<PullRequest> {
    const base = `/repos/${repo.projectKey}/${repo.repoSlug}/pulls/${prId}`;
    const [pull, reviews] = await Promise.all([
      this.client.get<GhPull>(base),
      collect(this.client.paginate<GhReview>(`${base}/reviews`)),
    ]);
    return this.mapPull(pull, this.buildReviewers(pull, reviews), this.mapMergeStatus(pull));
  }

  /**
   * List PR commits: the GitHub endpoint is oldest-first, reversed to newest-first per the contract on return.
   */
  async listPullRequestCommits(repo: RepoRef, prId: string): Promise<PrCommit[]> {
    const out: PrCommit[] = [];
    for await (const c of this.client.paginate<GhCommit>(
      `/repos/${repo.projectKey}/${repo.repoSlug}/pulls/${prId}/commits`,
    )) {
      out.push(this.mapCommit(c));
    }
    // GitHub commits are oldest-first; the contract requires newest-first
    return out.reverse();
  }

  /**
   * Distill the PR's reviews into review-decision activity events.
   *
   * Only decision states with a submit time (APPROVED / CHANGES_REQUESTED / DISMISSED) are kept, COMMENTED / PENDING are skipped.
   */
  async listPullRequestActivity(repo: RepoRef, prId: string): Promise<PrActivityEvent[]> {
    const reviews = await collect(
      this.client.paginate<GhReview>(
        `/repos/${repo.projectKey}/${repo.repoSlug}/pulls/${prId}/reviews`,
      ),
    );
    const out: PrActivityEvent[] = [];
    for (const r of reviews) {
      // COMMENTED / PENDING are not decisions; skip when submitted_at is missing (draft state)
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
   * Write the current user's review status on the PR.
   *
   * approved / needsWork each submit one review (REQUEST_CHANGES needs a body); unapproved dismisses the user's most recent
   * decisive review (dismiss).
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
      // GitHub requires REQUEST_CHANGES to carry a body (content sent to GitHub, using neutral English text)
      await this.client.post(`${prefix}/pulls/${prId}/reviews`, {
        event: 'REQUEST_CHANGES',
        body: 'Changes requested',
      });
      return;
    }
    // unapproved: dismiss the current user's most recent APPROVED / CHANGES_REQUESTED review
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
   * Merge a PR (uses merge commit only, no fallback to squash/rebase).
   *
   * When not mergeable (merge commit disabled / conflict / required reviews or checks not passed / behind / no permission), GitHub returns 405 or 403,
   * and the error bubbles up to the upper layer via the client carrying the response body message.
   */
  async mergePullRequest(repo: RepoRef, prId: string): Promise<void> {
    // Uses merge commit only (empty body = default merge_method=merge), no fallback to squash/rebase.
    // On failure (repo disables merge commit / conflict / required reviews not passed / required checks not passed / branch behind / no permission) → GitHub returns
    // 405 "not mergeable" or 403, the client carries the response body message into GitHubClientError and bubbles it up.
    await this.client.put(`/repos/${repo.projectKey}/${repo.repoSlug}/pulls/${prId}/merge`, {});
  }

  // ---- Mapping (domain-private) ----

  /**
   * Build the search/issues query string by discovery filter category (limited to open, non-archived, PR type).
   */
  private discoveryQuery(filter: PrDiscoveryFilter): string {
    return `is:open is:pr ${FILTER_QUALIFIER[filter]} archived:false`;
  }

  /**
   * Parse owner / repo from the search hit's repository_url; throws if unparseable.
   */
  private parseRepositoryUrl(repositoryUrl: string): { owner: string; repo: string } {
    // https://api.github.com/repos/{owner}/{repo}
    const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(repositoryUrl);
    if (!m) throw new Error(`Cannot parse repository_url: ${repositoryUrl}`);
    return { owner: m[1]!, repo: m[2]! };
  }

  /**
   * Map GitHub's mergeable / mergeable_state to a unified merge status.
   *
   * GitHub veto info is only partial fidelity, approximately classified by state into a single veto code (conflict / protected / behind / checks failed /
   * checking); canMerge is true only when mergeable=true and state=clean.
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
   * Assemble the reviewer list: first place "requested but not yet reviewed" people as placeholders (unapproved), then override with each person's most recent decision state in ascending time order.
   */
  private buildReviewers(pull: GhPull, reviews: GhReview[]): Reviewer[] {
    const byLogin = new Map<string, Reviewer>();
    // First place "requested but not yet reviewed" reviewers (pending = unapproved)
    for (const u of pull.requested_reviewers ?? []) {
      byLogin.set(u.login, { ...mapUser(u), status: 'unapproved' });
    }
    // reviews in ascending time order, override with each person's most recent "decisive" status
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
   * Normalize GitHub PR details (including the assembled reviewers and merge status) into a neutral PullRequest.
   *
   * State is mapped by merged / closed / else to merged / declined / open.
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
      // Conversation comments + inline review comments; an inline reply is itself a review_comment → includes replies (capabilities marks true).
      commentCount: (p.comments ?? 0) + (p.review_comments ?? 0),
    };
  }

  /**
   * Normalize a GitHub commit into a neutral PrCommit; when author / committer info is missing, fall back level by level git name → login → fallback.
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
