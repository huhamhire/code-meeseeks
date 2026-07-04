import type { ProxyConfig } from '@meebox/shared';

/** Injectable fetch (test stub / proxy wrapper); the connection layer uses the global fetch by default. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Binary resource (avatar / attachment): raw bytes + content-type, for the main side to cache and turn into a data URL. */
export interface BinaryResource {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Proxy fetch factory (injection point). Given the unified proxy config and the target host, produces a "proxy-aware" fetch; on loopback / proxy
 * disabled returns undefined (the connection layer falls back to the direct global fetch). Concrete transport implementations such as undici ProxyAgent are left to the injector
 * (desktop), so platform-core does not depend on a concrete proxy implementation.
 */
export type ProxyFetchFactory = (proxy: ProxyConfig, host: string) => FetchLike | undefined;

/**
 * Unified config for a platform connection. The connection layer (unified connection wrapper instance) is constructed from it—containing connection params, auth token, and the **unified proxy
 * config**. Proxy resolution (loopback direct / otherwise attach proxy) is done once by the connection layer by `baseUrl` host, no longer pre-assembled as a fetch by each call site
 * (see docs/arch/01-platform/01-adapter.md §1).
 */
export interface PlatformConnectionConfig {
  /** Platform REST API base, without trailing slash. */
  baseUrl: string;
  /** Personal Access Token; enters only the connection layer, never the logs. */
  token: string;
  /** Per-request timeout (default 30s). */
  timeoutMs?: number;
  /** Unified proxy config; the connection layer resolves the effective fetch from it + `baseUrl` host via `proxyFetch`. */
  proxy?: ProxyConfig;
  /**
   * Proxy fetch factory (injection point). The undici implementation is provided by the composition root (desktop); the connection layer resolves the proxy-aware fetch by
   * calling it with `proxy` + `baseUrl` host. When not provided, no proxy is attached (direct connection even if `proxy` exists).
   */
  proxyFetch?: ProxyFetchFactory;
  /** Explicit fetch override (test stub / proxy already resolved on its own); when given, takes priority over `proxy` resolution. */
  fetch?: FetchLike;
}

/**
 * Platform connection transport port. Domain base classes depend only on this interface to make calls, unaware of the underlying fetch / auth / pagination / error-parsing
 * implementation. Each platform package provides a "unified connection wrapper instance" implementing this port (see docs/arch/01-platform/01-adapter.md §1).
 *
 * Declares only the **minimal connection capability** isomorphic across the three platforms—pure JSON read/write + pagination. Platform-specific methods (GitHub PATCH / search, binary fetches whose
 * trust models differ wildly across platforms, etc.) are provided by each transport implementation as extensions outside the port, not polluting the common contract; binary resources are
 * abstracted per platform by the MediaService domain base class (see §3.2), so they do not enter this port.
 */
export interface PlatformTransport {
  /** GET, returns the JSON body. */
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
  /** GET, returns the JSON body + response headers (for reading server version / current user / pagination headers). */
  getWithHeaders<T>(
    path: string,
    params?: Record<string, string>,
  ): Promise<{ body: T; headers: Headers }>;
  /** POST JSON, returns the JSON body. */
  post<T>(path: string, body: unknown): Promise<T>;
  /** PUT JSON; some endpoints return 204 with no body, returning null. */
  put<T>(path: string, body: unknown): Promise<T | null>;
  /** DELETE, no return body. */
  del(path: string): Promise<void>;
  /** List pagination iterator (each platform's pagination style is funneled inside the implementation into a unified async iteration). */
  paginate<T>(path: string, params?: Record<string, string>): AsyncIterable<T>;
}
