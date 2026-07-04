import { MutableConnectionContext, type PlatformAdapter } from '@meebox/platform-core';
import { GitHubClient, type GitHubAdapterOptions } from './client.js';
import { GitHubConnection } from './features/connection.js';
import { GitHubPullRequestService } from './features/pull-request.js';
import { GitHubCommentService } from './features/comment.js';
import { GitHubMediaService } from './features/media.js';

export { normalizeGitHubApiBase, type GitHubAdapterOptions } from './client.js';

/**
 * GitHub adapter: domain service container (connection / prs / comments / media); the four domains share one connection context
 * (unified connection wrapper instance + current user cache).
 */
export class GitHubAdapter implements PlatformAdapter {
  readonly kind = 'github' as const;
  readonly connection: GitHubConnection;
  readonly prs: GitHubPullRequestService;
  readonly comments: GitHubCommentService;
  readonly media: GitHubMediaService;

  constructor(opts: GitHubAdapterOptions) {
    const client = new GitHubClient(opts);
    const ctx = new MutableConnectionContext(client);
    this.connection = new GitHubConnection(ctx, client);
    this.prs = new GitHubPullRequestService(ctx, client);
    this.comments = new GitHubCommentService(ctx, client);
    this.media = new GitHubMediaService(ctx, client);
  }
}
