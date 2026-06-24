import type {
  ListPendingOptions,
  PingResult,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformUser,
  PrActivityEvent,
  PrComment,
  PrCommentAnchor,
  PrCommit,
  PullRequest,
  RepoRef,
  ReviewerStatus,
} from '@meebox/shared';
import { MutableConnectionContext } from '@meebox/platform-core';
import { GitHubClient, type GitHubAdapterOptions } from './client.js';
import { GitHubConnection } from './features/connection.js';
import { GitHubPullRequestService } from './features/pull-request.js';
import { GitHubCommentService } from './features/comment.js';
import { GitHubMediaService } from './features/media.js';

export { normalizeGitHubApiBase, type GitHubAdapterOptions } from './client.js';

/**
 * GitHub 适配器：领域服务容器（connection / pulls / comments / media），四个领域共享一份连接上下文
 * （统一连接封装实例 + 当前用户缓存）。
 *
 * 过渡期同时实现旧的扁平 PlatformAdapter 接口（各方法委托给对应领域服务），使消费方在迁移到
 * `adapter.<domain>.<method>` 前保持可用；消费方迁移完成后移除扁平委托。
 */
export class GitHubAdapter implements PlatformAdapter {
  readonly kind = 'github' as const;
  readonly connection: GitHubConnection;
  readonly pulls: GitHubPullRequestService;
  readonly comments: GitHubCommentService;
  readonly media: GitHubMediaService;

  constructor(opts: GitHubAdapterOptions) {
    const client = new GitHubClient(opts);
    const ctx = new MutableConnectionContext(client);
    this.connection = new GitHubConnection(ctx, client);
    this.pulls = new GitHubPullRequestService(ctx, client);
    this.comments = new GitHubCommentService(ctx, client);
    this.media = new GitHubMediaService(ctx, client);
  }

  // ---- 扁平接口委托（过渡期兼容；迁移完成后移除）----

  capabilities(): PlatformCapabilities {
    return this.connection.capabilities();
  }
  ping(): Promise<PingResult> {
    return this.connection.ping();
  }
  getCurrentUser(): PlatformUser | null {
    return this.connection.getCurrentUser();
  }
  setCurrentUser(user: PlatformUser | null): void {
    this.connection.setCurrentUser(user);
  }
  getCloneUrl(repo: RepoRef): Promise<string> {
    return this.connection.getCloneUrl(repo);
  }
  listPendingPullRequests(opts?: ListPendingOptions): Promise<PullRequest[]> {
    return this.pulls.listPendingPullRequests(opts);
  }
  listPullRequestCommits(repo: RepoRef, prId: string): Promise<PrCommit[]> {
    return this.pulls.listPullRequestCommits(repo, prId);
  }
  listPullRequestActivity(repo: RepoRef, prId: string): Promise<PrActivityEvent[]> {
    return this.pulls.listPullRequestActivity(repo, prId);
  }
  setPullRequestReviewStatus(repo: RepoRef, prId: string, status: ReviewerStatus): Promise<void> {
    return this.pulls.setPullRequestReviewStatus(repo, prId, status);
  }
  mergePullRequest(repo: RepoRef, prId: string): Promise<void> {
    return this.pulls.mergePullRequest(repo, prId);
  }
  listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]> {
    return this.comments.listPullRequestComments(repo, prId);
  }
  publishSummaryComment(repo: RepoRef, prId: string, body: string): Promise<PrComment> {
    return this.comments.publishSummaryComment(repo, prId, body);
  }
  publishInlineComment(
    repo: RepoRef,
    prId: string,
    anchor: PrCommentAnchor,
    body: string,
  ): Promise<PrComment> {
    return this.comments.publishInlineComment(repo, prId, anchor, body);
  }
  replyToComment(
    repo: RepoRef,
    prId: string,
    parentCommentId: string,
    body: string,
  ): Promise<PrComment> {
    return this.comments.replyToComment(repo, prId, parentCommentId, body);
  }
  editComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    version: number,
    body: string,
  ): Promise<PrComment> {
    return this.comments.editComment(repo, prId, commentId, version, body);
  }
  deleteComment(repo: RepoRef, prId: string, commentId: string, version: number): Promise<void> {
    return this.comments.deleteComment(repo, prId, commentId, version);
  }
  getUserAvatar(
    slug: string,
    avatarUrl?: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    return this.media.getUserAvatar(slug, avatarUrl);
  }
  getAttachment(
    url: string,
    repo?: RepoRef,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    return this.media.getAttachment(url, repo);
  }
}
