export type {
  FetchLike,
  BinaryResource,
  ProxyFetchFactory,
  PlatformConnectionConfig,
  PlatformTransport,
} from './transport.js';
export {
  DEFAULT_TIMEOUT_MS,
  stripTrailingSlash,
  hostOf,
  buildUrl,
  fetchWithTimeout,
  parseNextLink,
  collect,
  extractApiMessage,
  resolveConnectionFetch,
} from './http.js';
export type { ConnectionContext } from './context.js';
export { MutableConnectionContext, PlatformDomainService } from './context.js';
export type { PlatformConnection } from './features/connection.js';
export { BaseConnection } from './features/connection.js';
export type { PullRequestService } from './features/pull-request.js';
export { BasePullRequestService } from './features/pull-request.js';
export type { CommentService } from './features/comment.js';
export { BaseCommentService } from './features/comment.js';
export type { MediaService } from './features/media.js';
export { BaseMediaService } from './features/media.js';
export type { PlatformAdapter, PlatformServices } from './adapter.js';
export { composePlatformAdapter } from './adapter.js';
export { MERGE_VETO_CODES, type MergeVetoCode } from './codes.js';
