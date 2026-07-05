import type { FetchLike, PlatformConnectionConfig } from './transport.js';

/** Default per-request timeout for the connection layer. */
export const DEFAULT_TIMEOUT_MS = 30_000;

const globalFetch: FetchLike = (input, init) => fetch(input, init);

/** Strip trailing slashes (for normalizing the base URL). */
export function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/** Get the host of a URL; returns an empty string on parse failure. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * Build the request URL: when `path` starts with http(s) it is requested as-is (pagination next / absolute resource URL); otherwise it is appended after `baseUrl`.
 * Optional query is written into searchParams.
 */
export function buildUrl(baseUrl: string, path: string, params?: Record<string, string>): string {
  const u = /^https?:\/\//.test(path) ? new URL(path) : new URL(`${baseUrl}${path}`);
  if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** fetch with a timeout (AbortController); aborts on timeout. `init.signal` is injected by this function, callers should not supply their own. */
export async function fetchWithTimeout(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Parse the `rel="next"` URL from the `Link` header; null if absent (shared by GitHub / GitLab Link-header pagination). */
export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m) return m[1] ?? null;
  }
  return null;
}

/** Collect an async iterator into an array. */
export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

/**
 * Extract the real-cause message the API gives from the error response body (JSON). Recognizes `{message}` (GitHub / Bitbucket) and `{error}`
 * (some GitLab endpoints); an object-typed message is serialized to a string. Non-JSON response body → empty string.
 */
export function extractApiMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
    const m = parsed.message ?? parsed.error;
    if (typeof m === 'string') return m;
    if (m && typeof m === 'object') return JSON.stringify(m);
  } catch {
    /* non-JSON response body, ignore */
  }
  return '';
}

/**
 * Resolve the connection layer's effective fetch, funneling proxy resolution into the connection layer (replacing each call site hand-assembling `proxyFetchForHost`):
 * - explicit `config.fetch` override takes priority (test stub / proxy already resolved on its own);
 * - otherwise resolve via the injected `config.proxyFetch` factory by the unified `config.proxy` + `baseUrl` host; when the factory returns undefined
 *   (loopback / proxy disabled), fall back to the direct global fetch;
 * - no proxy / no factory → direct global fetch.
 */
export function resolveConnectionFetch(config: PlatformConnectionConfig): FetchLike {
  if (config.fetch) return config.fetch;
  if (config.proxy && config.proxyFetch) {
    return config.proxyFetch(config.proxy, hostOf(config.baseUrl)) ?? globalFetch;
  }
  return globalFetch;
}
