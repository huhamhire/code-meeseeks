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
