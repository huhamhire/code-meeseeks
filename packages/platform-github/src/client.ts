import type { RepoRef } from '@meebox/shared';
import {
  buildUrl,
  extractApiMessage,
  fetchWithTimeout,
  parseNextLink,
  resolveConnectionFetch,
  stripTrailingSlash,
  type BinaryResource,
  type FetchLike,
  type PlatformConnectionConfig,
  type PlatformTransport,
} from '@meebox/platform-core';

/** GitHub connection config = unified connection config + clone protocol (connection-layer-managed connection config, not HTTP transport details). */
export interface GitHubClientOptions extends PlatformConnectionConfig {
  /** clone protocol: 'pat' (default) uses HTTPS + username:PAT; 'ssh' uses the system ssh config */
  cloneProtocol?: 'pat' | 'ssh';
}

/** Adapter construction options are the same shape as the connection config. */
export type GitHubAdapterOptions = GitHubClientOptions;

export class GitHubClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'GitHubClientError';
  }
}

const API_VERSION = '2022-11-28';
const ACCEPT = 'application/vnd.github+json';

/**
 * Fault-tolerant normalization of the GitHub API base: the user may enter only the instance address or a full API base.
 * - `github.com` / `www.github.com` (or the official domain in the empty case) → official API host `https://api.github.com`;
 * - GitHub Enterprise Server instance root `https://ghe.example.com` → append `/api/v3` (kept as-is if it already has `/api/vN`).
 */
export function normalizeGitHubApiBase(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (u.hostname === 'api.github.com') return trimmed;
  if (u.hostname === 'github.com' || u.hostname === 'www.github.com')
    return 'https://api.github.com';
  if (/\/api\/v\d+$/.test(u.pathname.replace(/\/+$/, ''))) return trimmed;
  return `${trimmed}/api/v3`;
}

/**
 * GitHub REST client = unified connection wrapper instance implementing {@link PlatformTransport}: self-manages connection /
 * auth config (base URL normalization, PAT, timeout, proxy resolution) and GitHub connection-derived state (web/git host,
 * clone protocol, clone URL construction). Generic transport boilerplate reuses `@meebox/platform-core` helpers;
 * GitHub-specific parts (auth headers / rate-limit hints / trusted asset hosts / search / patch / clone) stay in this class.
 * Business semantics are left to the domain services.
 *
 * When path starts with `/` it is joined onto baseUrl; when a full http(s) URL is passed it is requested as-is (used for pagination next / avatars etc.).
 */
export class GitHubClient implements PlatformTransport {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly cloneProtocol: 'pat' | 'ssh';
  /** web / git host base (api.github.com → https://github.com; GHE → instance host). */
  readonly webBase: string;
  private readonly gitHost: string;

  constructor(opts: GitHubClientOptions) {
    const apiBase = normalizeGitHubApiBase(opts.baseUrl);
    this.baseUrl = stripTrailingSlash(apiBase);
    this.token = opts.token;
    // Connection layer uniformly resolves the effective fetch (explicit fetch override > proxy > direct).
    this.fetchFn = resolveConnectionFetch({ ...opts, baseUrl: apiBase });
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.cloneProtocol = opts.cloneProtocol ?? 'pat';
    const api = new URL(apiBase);
    // github.com's API is at api.github.com, but clone/web is at github.com; GHE shares the same host.
    this.webBase =
      api.hostname === 'api.github.com' ? 'https://github.com' : `${api.protocol}//${api.host}`;
    this.gitHost = new URL(this.webBase).host;
  }

  private authHeaders(accept = ACCEPT): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: accept,
      'X-GitHub-Api-Version': API_VERSION,
    };
  }

  private async raw(method: string, url: string, body?: unknown): Promise<Response> {
    return fetchWithTimeout(
      this.fetchFn,
      url,
      {
        method,
        headers:
          body === undefined
            ? this.authHeaders()
            : { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      this.timeoutMs,
    );
  }

  private async err(res: Response, method: string, urlOrPath: string): Promise<GitHubClientError> {
    const txt = await res.text().catch(() => '');
    // GitHub error bodies are JSON, and message is the real cause (e.g. merge 405 "Pull Request is not mergeable").
    const apiMsg = extractApiMessage(txt);
    const detail = apiMsg ? `：${apiMsg}` : '';
    // Rate limit (403/429 + X-RateLimit-Remaining: 0) gives a more readable hint to help upper layers throttle.
    const remaining = res.headers.get('x-ratelimit-remaining');
    const rateLimited = (res.status === 403 || res.status === 429) && remaining === '0';
    const hint = rateLimited ? '（GitHub API 限流，请稍后重试）' : '';
    return new GitHubClientError(
      `${String(res.status)} ${res.statusText} on ${method} ${urlOrPath}${detail}${hint}`,
      res.status,
      txt,
    );
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const { body } = await this.getWithHeaders<T>(path, params);
    return body;
  }

  /** Same as get, but also returns the response headers (used by ping to read the GHE version / by pagination to read Link). */
  async getWithHeaders<T>(
    path: string,
    params?: Record<string, string>,
  ): Promise<{ body: T; headers: Headers }> {
    const url = buildUrl(this.baseUrl, path, params);
    const res = await this.raw('GET', url);
    if (!res.ok) throw await this.err(res, 'GET', new URL(url).pathname);
    const body = (await res.json()) as T;
    return { body, headers: res.headers };
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.raw('POST', buildUrl(this.baseUrl, path), body);
    if (!res.ok) throw await this.err(res, 'POST', path);
    return (await res.json()) as T;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await this.raw('PATCH', buildUrl(this.baseUrl, path), body);
    if (!res.ok) throw await this.err(res, 'PATCH', path);
    return (await res.json()) as T;
  }

  /** PUT; some endpoints (merge / dismissals) return JSON, returns null when empty. */
  async put<T>(path: string, body: unknown): Promise<T | null> {
    const res = await this.raw('PUT', buildUrl(this.baseUrl, path), body);
    if (!res.ok) throw await this.err(res, 'PUT', path);
    if (res.status === 204) return null;
    try {
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  async del(path: string): Promise<void> {
    const res = await this.raw('DELETE', buildUrl(this.baseUrl, path));
    if (!res.ok) throw await this.err(res, 'DELETE', path);
  }

  /**
   * GitHub `Link` header pagination: list endpoints return a JSON array, the next-page address is in `Link: <url>; rel="next"`.
   * Follow next page by page until there is none. per_page=100.
   */
  async *paginate<T>(path: string, params: Record<string, string> = {}): AsyncIterable<T> {
    let url: string | null = buildUrl(this.baseUrl, path, { per_page: '100', ...params });
    while (url) {
      const res = await this.raw('GET', url);
      if (!res.ok) throw await this.err(res, 'GET', new URL(url).pathname);
      const items = (await res.json()) as T[];
      for (const it of items) yield it;
      url = parseNextLink(res.headers.get('link'));
    }
  }

  /**
   * Search endpoints (`/search/issues` etc.): return `{ items, total_count }`, pagination also goes through the Link header.
   * Note the search rate limit of 30/min; callers should throttle.
   */
  async *searchItems<T>(path: string, params: Record<string, string>): AsyncIterable<T> {
    let url: string | null = buildUrl(this.baseUrl, path, { per_page: '100', ...params });
    while (url) {
      const res = await this.raw('GET', url);
      if (!res.ok) throw await this.err(res, 'GET', new URL(url).pathname);
      const page = (await res.json()) as { items: T[] };
      for (const it of page.items) yield it;
      url = parseNextLink(res.headers.get('link'));
    }
  }

  /**
   * Construct the git clone URL: ssh → `git@<gitHost>:<proj>/<repo>.git`; pat → embed
   * `<currentUser>:<PAT>` in the web host. pat requires ping() to have already landed the current user (passed in by the caller via connection context), otherwise it throws.
   */
  getCloneUrl(repo: RepoRef, currentUserName?: string): string {
    if (this.cloneProtocol === 'ssh') {
      return `git@${this.gitHost}:${repo.projectKey}/${repo.repoSlug}.git`;
    }
    if (!currentUserName) {
      throw new Error(
        'cannot construct PAT clone URL: current user unknown — ping() not called or failed',
      );
    }
    const u = new URL(this.webBase);
    u.pathname = `/${repo.projectKey}/${repo.repoSlug}.git`;
    u.username = currentUserName;
    u.password = this.token;
    return u.toString();
  }

  /**
   * Determine whether the target host is a trusted GitHub/GHE asset host for this connection — only trusted hosts carry the PAT.
   * github.com: api.github.com + github.com + *.githubusercontent.com (avatars / user-attachments
   * etc. are all here). GHE: the instance host and its subdomains (media assets are usually under the same instance). Everything else (external
   * image URLs placed by an attacker in a comment) carries no credentials, to avoid the PAT leaking outbound.
   */
  private isTrustedAssetHost(host: string): boolean {
    const apiHost = new URL(this.baseUrl).host;
    if (host === apiHost) return true;
    if (apiHost === 'api.github.com') {
      return (
        host === 'github.com' ||
        host === 'githubusercontent.com' ||
        host.endsWith('.githubusercontent.com')
      );
    }
    // GHE: same host as the instance or its subdomains
    return host === apiHost || host.endsWith(`.${apiHost}`);
  }

  /**
   * Fetch a binary resource (avatar / comment inline image). url is a full http(s). **Only proxies trusted GitHub/GHE asset hosts**
   * (carrying the PAT to fetch private resources); non-trusted hosts (e.g. external image URLs placed by an attacker in a comment) return null directly — neither
   * sending out the PAT (preventing leakage) nor letting the main process proxy-fetch arbitrary external URLs (preventing SSRF), leaving the renderer to fall back to native <img> loading.
   * Non-2xx / exception → also returns null to let the upper layer fall back.
   */
  async getBinary(url: string): Promise<BinaryResource | null> {
    if (!/^https?:\/\//.test(url)) return null;
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return null;
    }
    if (!this.isTrustedAssetHost(host)) return null;
    let res: Response;
    try {
      res = await fetchWithTimeout(
        this.fetchFn,
        url,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'image/*,*/*;q=0.5' },
        },
        this.timeoutMs,
      );
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}
