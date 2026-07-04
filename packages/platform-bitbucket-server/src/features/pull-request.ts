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

/** Bitbucket activity action → review verdict event kind (verdicts only; other actions absent from the table → skipped). */
const ACTIVITY_KIND_BY_ACTION: Record<string, PrActivityKind> = {
  APPROVED: 'approved',
  UNAPPROVED: 'unapproved',
  REVIEWED: 'needsWork',
};

/** Bitbucket participant.status → neutral reviewer status (falls back to the approved boolean when absent, see mapReviewer). */
const REVIEWER_STATUS_BY_STATUS: Partial<
  Record<NonNullable<BitbucketParticipant['status']>, ReviewerStatus>
> = {
  APPROVED: 'approved',
  NEEDS_WORK: 'needsWork',
  UNAPPROVED: 'unapproved',
};

/** Neutral review status → Bitbucket participant status (used to write approval). */
const BB_STATUS_BY_REVIEW: Record<ReviewerStatus, string> = {
  approved: 'APPROVED',
  needsWork: 'NEEDS_WORK',
  unapproved: 'UNAPPROVED',
};

/** Bitbucket PR operations domain: dashboard discovery, commits, activity verdicts, approval, merge. */
export class BitbucketPullRequestService extends BasePullRequestService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: BitbucketClient,
  ) {
    super(ctx);
  }

  /**
   * Discover pending PRs via dashboard aggregation, fetching each PR's /merge status in parallel to normalize mergeability.
   *
   * Discovery category → dashboard role: created=authored by me (AUTHOR), rest (awaiting my review)=REVIEWER. A single /merge
   * failure degrades to "no known blockers" (canMerge=true / no conflict / no vetoes), matching the original hasConflict failure degradation.
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

  /**
   * Fetch a single PR from the remote by repo + number (details + mergeability, reusing the mapping); 404 / 403 thrown by the client for upstream normalization.
   *
   * `/merge` is only meaningful for **OPEN** PRs — calling it on a merged / declined PR returns 409
   * IllegalPullRequestStateException, so a non-OPEN PR degrades to a neutral merge state (not mergeable / no conflict).
   * The discovery list only lists OPEN PRs and does not take this path; this degradation only affects the "open by URL" case for retired PRs.
   */
  async getSinglePullRequest(repo: RepoRef, prId: string): Promise<PullRequest> {
    const base = `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}`;
    const pr = await this.client.get<BitbucketPullRequest>(base);
    const mergeStatus: MergeStatus =
      pr.state === 'OPEN'
        ? this.mapMergeStatus(await this.fetchMergeStatus(pr))
        : { canMerge: false, conflicted: false, vetoes: [] };
    return this.mapPullRequest(pr, mergeStatus);
  }

  /**
   * List all commits of a PR (newest-first, consistent with git log).
   *
   * Collects paginated results all at once — a PR usually has only dozens of commits, so not paginating is fine.
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
   * Pick review verdict events out of the /activities stream (APPROVED / UNAPPROVED / REVIEWED=marks Needs Work).
   *
   * Comments (COMMENTED) go through the comment domain; here only verdicts are taken; non-verdict actions are skipped.
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
   * Write the current PAT user's review status on the PR to the remote (PUT participants/{userSlug}).
   *
   * Requires ping() to have populated the current user (takes slug + name to build the endpoint and body), otherwise throws.
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
   * Merge a PR: first fetch the latest PR to get version (optimistic lock), then POST /merge?version=N.
   *
   * Already merged (merged by someone else / double click) returns 409 + IllegalPullRequestStateException → normalized to the
   * PR_ALREADY_MERGED error code for frontend i18n; other 409s (conflict / veto / no permission) bubble up as-is.
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

  // ---- mapping (domain-private) ----

  /** Fetch a single PR's /merge status (canMerge / conflicted / vetoes fetched together from one source). */
  private async fetchMergeStatus(pr: BitbucketPullRequest): Promise<BitbucketMergeStatus> {
    const project = pr.toRef.repository.project.key;
    const repo = pr.toRef.repository.slug;
    return this.client.get<BitbucketMergeStatus>(
      `/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests/${String(pr.id)}/merge`,
    );
  }

  /** Bitbucket `/merge` response → neutral MergeStatus; vetoes come straight from the server as text, normalized to an empty array when absent. */
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

  /** Bitbucket participant → neutral Reviewer; falls back to the approved boolean when status (7.x+) is absent. */
  private mapReviewer(p: BitbucketParticipant): Reviewer {
    const mapped = p.status ? REVIEWER_STATUS_BY_STATUS[p.status] : undefined;
    const status: ReviewerStatus = mapped ?? (p.approved ? 'approved' : 'unapproved');
    return { ...mapUser(p.user), status };
  }

  /** Bitbucket PR → neutral PullRequest; hasConflict is a derived mirror of mergeStatus.conflicted. */
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
      // Top-level comment count only (replies not counted); capabilities.commentCountIncludesReplies=false marks its coarse granularity.
      commentCount: bb.properties?.commentCount,
    };
  }

  /** Bitbucket commit → neutral PrCommit, with the commit details page URL attached. */
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
   * A Bitbucket commit's author/committer only gives name (including email), no slug / displayName.
   *
   * Here name is used as both name + displayName, slug is left empty (UI avatar falls back to initials), email is dropped for now.
   */
  private committerToUser(c: { name: string; emailAddress?: string }): PlatformUser {
    return { name: c.name, displayName: c.name };
  }

  /**
   * Determine whether the error is "PR already merged": Bitbucket returns 409 +
   * IllegalPullRequestStateException for a merge request on a merged / closed PR, with the error body containing "already … merged". Other 409s (conflict / veto / no permission) are not included.
   */
  private isAlreadyMergedError(err: unknown): boolean {
    if (!(err instanceof BitbucketClientError) || err.status !== 409) return false;
    const body = err.body.toLowerCase();
    return body.includes('illegalpullrequeststateexception') && body.includes('merged');
  }
}
