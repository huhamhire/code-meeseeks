import { MutableConnectionContext, type PlatformAdapter } from '@meebox/platform-core';
import { GitLabClient, type GitLabAdapterOptions } from './client.js';
import { GitLabConnection } from './features/connection.js';
import { GitLabPullRequestService } from './features/pull-request.js';
import { GitLabCommentService } from './features/comment.js';
import { GitLabMediaService } from './features/media.js';

export { normalizeGitLabApiBase, type GitLabAdapterOptions } from './client.js';

/**
 * GitLab 适配器：领域服务容器（connection / prs / comments / media），四个领域共享一份连接上下文
 * （统一连接封装实例 + 当前用户缓存）。
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
