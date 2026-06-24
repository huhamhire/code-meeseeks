import { MutableConnectionContext, type PlatformAdapter } from '@meebox/platform-core';
import { BitbucketClient, type BitbucketServerAdapterOptions } from './client.js';
import { BitbucketServerConnection } from './features/connection.js';
import { BitbucketPullRequestService } from './features/pull-request.js';
import { BitbucketCommentService } from './features/comment.js';
import { BitbucketMediaService } from './features/media.js';

export type { BitbucketServerAdapterOptions } from './client.js';

/**
 * Bitbucket Server 适配器：领域服务容器（connection / prs / comments / media），四个领域共享一份
 * 连接上下文（统一连接封装实例 + 当前用户缓存）。
 */
export class BitbucketServerAdapter implements PlatformAdapter {
  readonly kind = 'bitbucket-server' as const;
  readonly connection: BitbucketServerConnection;
  readonly prs: BitbucketPullRequestService;
  readonly comments: BitbucketCommentService;
  readonly media: BitbucketMediaService;

  constructor(opts: BitbucketServerAdapterOptions) {
    const client = new BitbucketClient(opts);
    const ctx = new MutableConnectionContext(client);
    this.connection = new BitbucketServerConnection(ctx, client);
    this.prs = new BitbucketPullRequestService(ctx, client);
    this.comments = new BitbucketCommentService(ctx, client);
    this.media = new BitbucketMediaService(ctx, client);
  }
}
