import type { PlatformKind } from '@meebox/shared';
import type { PlatformConnection } from './features/connection.js';
import type { PullRequestService } from './features/pull-request.js';
import type { CommentService } from './features/comment.js';
import type { MediaService } from './features/media.js';

/**
 * Platform adapter (root / aggregate client): a domain-service container. The business layer fetches the service it needs per domain (`adapter.comments.list(...)`),
 * instead of facing one giant interface. Composition is done by {@link composePlatformAdapter}.
 */
export interface PlatformAdapter {
  readonly kind: PlatformKind;
  readonly connection: PlatformConnection;
  readonly prs: PullRequestService;
  readonly comments: CommentService;
  readonly media: MediaService;
}

/**
 * Domain-service set: an input container of the four domain services, fed to {@link composePlatformAdapter} to assemble the root adapter.
 */
export interface PlatformServices {
  connection: PlatformConnection;
  prs: PullRequestService;
  comments: CommentService;
  media: MediaService;
}

/** Assemble the four domain services into a root PlatformAdapter (domain-service container). The root holds no business logic, only holds and exposes each domain. */
export function composePlatformAdapter(services: PlatformServices): PlatformAdapter {
  return {
    kind: services.connection.kind,
    connection: services.connection,
    prs: services.prs,
    comments: services.comments,
    media: services.media,
  };
}
