import type { PlatformKind } from '@meebox/shared';
import type { PlatformConnection } from './features/connection.js';
import type { PullRequestService } from './features/pull-request.js';
import type { CommentService } from './features/comment.js';
import type { MediaService } from './features/media.js';

/**
 * 平台适配器（根 / 总 client）：领域服务容器。业务层经此按领域取所需服务（`adapter.comments.list(...)`），
 * 不再面对单一巨接口。组合由 {@link composePlatformAdapter} 完成。
 */
export interface PlatformAdapter {
  readonly kind: PlatformKind;
  readonly connection: PlatformConnection;
  readonly pulls: PullRequestService;
  readonly comments: CommentService;
  readonly media: MediaService;
}

/** 领域服务集合，喂给 {@link composePlatformAdapter}。 */
export interface PlatformServices {
  connection: PlatformConnection;
  pulls: PullRequestService;
  comments: CommentService;
  media: MediaService;
}

/** 把四个领域服务组装成根 PlatformAdapter（领域服务容器）。根不含业务逻辑，只持有并暴露各领域。 */
export function composePlatformAdapter(services: PlatformServices): PlatformAdapter {
  return {
    kind: services.connection.kind,
    connection: services.connection,
    pulls: services.pulls,
    comments: services.comments,
    media: services.media,
  };
}
