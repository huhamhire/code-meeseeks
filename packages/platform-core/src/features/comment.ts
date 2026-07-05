import type { PrComment, PrCommentAnchor, RepoRef } from '@meebox/shared';
import { PlatformDomainService } from '../context.js';

/** Comments: full read-write cycle (summary / inline / reply / edit / delete). */
export interface CommentService {
  /**
   * List all existing comments on a PR (inline + summary).
   *
   * Replies are returned nested via comment.replies, so the caller receives an already-tree'd comment list.
   */
  listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]>;

  /**
   * Post a summary comment on a PR (top-level, not anchored to a file).
   */
  publishSummaryComment(repo: RepoRef, prId: string, body: string): Promise<PrComment>;

  /**
   * Post an inline comment on the PR diff, anchored to a specific file + line number.
   */
  publishInlineComment(
    repo: RepoRef,
    prId: string,
    anchor: PrCommentAnchor,
    body: string,
  ): Promise<PrComment>;

  /**
   * Reply under an existing comment.
   */
  replyToComment(
    repo: RepoRef,
    prId: string,
    parentCommentId: string,
    body: string,
  ): Promise<PrComment>;

  /**
   * Edit a comment on a PR (change the body text).
   *
   * version is an optimistic lock, validated only by Bitbucket, ignored by other platforms.
   */
  editComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    version: number,
    body: string,
  ): Promise<PrComment>;

  /**
   * Delete a comment on a PR.
   *
   * version is an optimistic lock, validated only by Bitbucket, ignored by other platforms.
   */
  deleteComment(repo: RepoRef, prId: string, commentId: string, version: number): Promise<void>;

  /**
   * Toggle the current user's given emoji reaction on a comment (add=true to add, false to remove). emoji is a normalized
   * Unicode character, translated by the adapter to its own native name. kind distinguishes summary / inline (GitHub selects the issue /
   * review reaction endpoint accordingly; other platforms ignore it). Idempotent: repeated add / remove-when-absent are both treated as success.
   * Implemented only by platforms whose `commentReactions` capability is true; unsupported platforms throw.
   */
  toggleReaction(
    repo: RepoRef,
    prId: string,
    commentId: string,
    kind: 'summary' | 'inline',
    emoji: string,
    add: boolean,
  ): Promise<void>;
}

/**
 * Comment domain base class: the full read-write contract methods are left for platform subclasses to implement against their respective endpoints.
 */
export abstract class BaseCommentService extends PlatformDomainService implements CommentService {
  /**
   * Implemented by platform subclasses: fetch all comments of a PR and normalize into a unified comment tree.
   */
  abstract listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]>;

  /**
   * Implemented by platform subclasses: post a top-level summary comment.
   */
  abstract publishSummaryComment(repo: RepoRef, prId: string, body: string): Promise<PrComment>;

  /**
   * Implemented by platform subclasses: post an inline comment on the diff anchored to a file + line number.
   */
  abstract publishInlineComment(
    repo: RepoRef,
    prId: string,
    anchor: PrCommentAnchor,
    body: string,
  ): Promise<PrComment>;

  /**
   * Implemented by platform subclasses: reply under a specified parent comment.
   */
  abstract replyToComment(
    repo: RepoRef,
    prId: string,
    parentCommentId: string,
    body: string,
  ): Promise<PrComment>;

  /**
   * Implemented by platform subclasses: edit a comment body (version optimistic lock validated or not per platform).
   */
  abstract editComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    version: number,
    body: string,
  ): Promise<PrComment>;

  /**
   * Implemented by platform subclasses: delete a comment (version optimistic lock validated or not per platform).
   */
  abstract deleteComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    version: number,
  ): Promise<void>;

  /**
   * Implemented by platform subclasses: toggle the current user's emoji reaction on a comment. Platforms not supporting reactions may leave it unoverridden (throws by default).
   */
  toggleReaction(
    _repo: RepoRef,
    _prId: string,
    _commentId: string,
    _kind: 'summary' | 'inline',
    _emoji: string,
    _add: boolean,
  ): Promise<void> {
    throw new Error('toggleReaction is not supported by this platform');
  }
}
