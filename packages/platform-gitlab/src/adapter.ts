import { MutableConnectionContext, type PlatformAdapter } from '@meebox/platform-core';
import { GitLabClient, type GitLabAdapterOptions } from './client.js';
import { GitLabConnection } from './features/connection.js';
import { GitLabPullRequestService } from './features/pull-request.js';
import { GitLabCommentService } from './features/comment.js';
import { GitLabMediaService } from './features/media.js';

export { normalizeGitLabApiBase, type GitLabAdapterOptions } from './client.js';

/**
 * GitLab adapter: domain service container (connection / prs / comments / media), where the four domains share one
 * connection context (a unified connection wrapper instance + current-user cache).
 */
export class GitLabAdapter implements PlatformAdapter {
  readonly kind = 'gitlab' as const;
  readonly connection: GitLabConnection;
  readonly prs: GitLabPullRequestService;
  readonly comments: GitLabCommentService;
  readonly media: GitLabMediaService;

  constructor(opts: GitLabAdapterOptions) {
    const client = new GitLabClient(opts);
    const ctx = new MutableConnectionContext(client);
    this.connection = new GitLabConnection(ctx, client);
    this.prs = new GitLabPullRequestService(ctx, client);
    this.comments = new GitLabCommentService(ctx, client);
    this.media = new GitLabMediaService(ctx, client);
  }
}
