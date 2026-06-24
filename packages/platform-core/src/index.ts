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
export type {
  PlatformConnection,
  PullRequestService,
  CommentService,
  MediaService,
  PlatformAdapter,
  ConnectionContext,
  PlatformServices,
} from './domains.js';
export {
  MutableConnectionContext,
  PlatformDomainService,
  BaseConnection,
  BasePullRequestService,
  BaseCommentService,
  BaseMediaService,
  composePlatformAdapter,
} from './domains.js';
