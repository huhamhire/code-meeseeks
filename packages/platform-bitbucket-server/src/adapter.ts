import { MutableConnectionContext, type PlatformAdapter } from '@meebox/platform-core';
import { BitbucketClient, type BitbucketServerAdapterOptions } from './client.js';
import { BitbucketServerConnection } from './features/connection.js';
import { BitbucketPullRequestService } from './features/pull-request.js';
import { BitbucketCommentService } from './features/comment.js';
import { BitbucketMediaService } from './features/media.js';

export type { BitbucketServerAdapterOptions } from './client.js';

/**
 * Bitbucket Server platform adapter: domain service container (connection / prs / comments / media);
 * the four domains share one connection context (unified connection wrapper instance + current-user cache).
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
