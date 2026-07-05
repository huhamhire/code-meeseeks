import type {
  ListPendingOptions,
  PrActivityEvent,
  PrCommit,
  PullRequest,
  RepoRef,
  ReviewerStatus,
} from '@meebox/shared';
import { PlatformDomainService } from '../context.js';

/** PR operations: discovery, commit / activity data, review decisions, merge. */
export interface PullRequestService {
  /**
   * List pending PRs, across projects and repositories.
   *
   * Discovers by review-requested by default; GitHub switches the discovery scope by opts.filter.
   */
  listPendingPullRequests(opts?: ListPendingOptions): Promise<PullRequest[]>;

  /**
   * **Fetch a single PR from the remote** by repo + id (bypassing the discovery list / cache), used for "open PR by URL".
   * On no permission / not found, the underlying client throws an error carrying the HTTP status (403 / 404), which the upper layer normalizes into an error code.
   */
  getSinglePullRequest(repo: RepoRef, prId: string): Promise<PullRequest>;

  /**
   * List all commits of a PR, sorted **newest first**.
   */
  listPullRequestCommits(repo: RepoRef, prId: string): Promise<PrCommit[]>;

  /**
   * List the "review decision" activity events on a PR (approve / needs-work / unapprove / dismiss), with timestamps.
   */
  listPullRequestActivity(repo: RepoRef, prId: string): Promise<PrActivityEvent[]>;

  /**
   * Write the current user's review status on this PR to the remote (approved / needsWork / unapproved).
   */
  setPullRequestReviewStatus(repo: RepoRef, prId: string, status: ReviewerStatus): Promise<void>;

  /**
   * Merge a PR into the target branch.
   *
   * Should only be called when mergeStatus.canMerge=true; the operation is irreversible.
   */
  mergePullRequest(repo: RepoRef, prId: string): Promise<void>;
}

/**
 * PR operations domain base class: all contract methods are left to platform subclasses to implement, only constraining the unified domain interface shape.
 */
export abstract class BasePullRequestService
  extends PlatformDomainService
  implements PullRequestService
{
  /**
   * Implemented by platform subclasses: discover pending PRs across projects and normalize into neutral types.
   */
  abstract listPendingPullRequests(opts?: ListPendingOptions): Promise<PullRequest[]>;

  /**
   * Implemented by platform subclasses: fetch a single PR from the remote by repo + id ("open PR by URL").
   */
  abstract getSinglePullRequest(repo: RepoRef, prId: string): Promise<PullRequest>;

  /**
   * Implemented by platform subclasses: list PR commits, returned newest first.
   */
  abstract listPullRequestCommits(repo: RepoRef, prId: string): Promise<PrCommit[]>;

  /**
   * Implemented by platform subclasses: list a PR's review decision activity events (platforms lacking the capability return empty).
   */
  abstract listPullRequestActivity(repo: RepoRef, prId: string): Promise<PrActivityEvent[]>;

  /**
   * Implemented by platform subclasses: write the current user's review status to the remote.
   */
  abstract setPullRequestReviewStatus(
    repo: RepoRef,
    prId: string,
    status: ReviewerStatus,
  ): Promise<void>;

  /**
   * Implemented by platform subclasses: merge a PR into the target branch.
   */
  abstract mergePullRequest(repo: RepoRef, prId: string): Promise<void>;
}
