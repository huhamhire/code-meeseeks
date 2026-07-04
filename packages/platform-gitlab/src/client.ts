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

/** GitLab connection config = unified connection config + clone protocol (connection-layer-managed connection config, not HTTP transport details). */
export interface GitLabClientOptions extends PlatformConnectionConfig {
  /** clone protocol: 'pat' (default) uses HTTPS + username:PAT; 'ssh' uses the system ssh config */
  cloneProtocol?: 'pat' | 'ssh';
}

/** Adapter constructor options share the shape of the connection config. */
export type GitLabAdapterOptions = GitLabClientOptions;

export class GitLabClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'GitLabClientError';
  }
}

const ACCEPT = 'application/json';

/**
 * Fault-tolerant normalization of the GitLab API base: users may enter just the instance address
 * (`https://gitlab.example.com`) or the full `.../api/v4`; uniformly append `/api/v4` (leave as-is if it
 * already carries `/api/vN`). Frees users from memorizing the API path.
 */
export function normalizeGitLabApiBase(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  return /\/api\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/api/v4`;
}

/**
 * Ultra-thin GitLab REST v4 client implementing {@link PlatformTransport}: `PRIVATE-TOKEN` PAT auth, `Link`-header
 * pagination iterator, binary fetch, errors thrown as GitLabClientError. Generic transport boilerplate (timeout / URL
 * building / error-message extraction / Link pagination / effective fetch resolution) reuses `@meebox/platform-core`
 * helpers; GitLab-specific parts (PRIVATE-TOKEN / asset-host auth mode / API binary endpoints) stay in this class.
 * Business semantics are left to GitLabAdapter.
 *
 * When path starts with `/`, it is joined onto baseUrl; when a full http(s) URL is passed, it is requested as-is (used for pagination next / avatars / attachments etc.).
 */
export class GitLabClient implements PlatformTransport {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly cloneProtocol: 'pat' | 'ssh';
  /** Instance web/git host (with /api/v4 stripped), used for clone / attachments / web pages. */
  private readonly webBase: string;
  readonly gitHost: string;
  /**
   * Whether the MR approval API (approve/unapprove) is available: since 13.9 it is Premium/Ultimate, absent on CE / EE-Free.
   * Written by the connection layer's ping() after edition detection via /metadata.enterprise; conservatively set to false (CE)
   * before detection. This is connection state obtained by this platform's connection probe, so it lives on the connection
   * wrapper instance, read by both the connection (capabilities) and PR (approval fetch) domains.
   */
  approvalsAvailable = false;

  constructor(opts: GitLabClientOptions) {
    const apiBase = normalizeGitLabApiBase(opts.baseUrl);
    this.baseUrl = stripTrailingSlash(apiBase);
    this.token = opts.token;
    // Connection layer uniformly resolves the effective fetch (explicit fetch override > proxy > direct).
    this.fetchFn = resolveConnectionFetch({ ...opts, baseUrl: apiBase });
    this.cloneProtocol = opts.cloneProtocol ?? 'pat';
    const api = new URL(apiBase);
    this.webBase = `${api.protocol}//${api.host}`;
    this.gitHost = api.host;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private authHeaders(): Record<string, string> {
    // GitLab PAT uses the PRIVATE-TOKEN header (only OAuth tokens use Authorization: Bearer).
    return { 'PRIVATE-TOKEN': this.token, Accept: ACCEPT };
  }

  /**
   * Build the git clone URL: ssh → `git@<gitHost>:<group>/<repo>.git`; pat → embed `<currentUser>:<PAT>`
   * in the web host. pat requires ping() to have already landed the current user (passed in by the caller via the
   * connection context), otherwise throws.
   */
  getCloneUrl(repo: RepoRef, currentUserName?: string): string {
    const path = `${repo.projectKey}/${repo.repoSlug}`;
    if (this.cloneProtocol === 'ssh') {
      return `git@${this.gitHost}:${path}.git`;
    }
    if (!currentUserName) {
      throw new Error(
        'cannot construct PAT clone URL: current user unknown — ping() not called or failed',
      );
    }
    const u = new URL(this.webBase);
    u.pathname = `/${path}.git`;
    u.username = currentUserName;
    u.password = this.token;
    return u.toString();
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

  private async err(res: Response, method: string, urlOrPath: string): Promise<GitLabClientError> {
    const txt = await res.text().catch(() => '');
    // GitLab error bodies are JSON: `{message}` or `{error}` (some endpoints). Including it in the error message helps
    // the upper layers localize the issue (e.g. merge 405 "Method Not Allowed" / approval 403 "approval ... not available").
    const apiMsg = extractApiMessage(txt);
    const detail = apiMsg ? `：${apiMsg}` : '';
    return new GitLabClientError(
      `${String(res.status)} ${res.statusText} on ${method} ${urlOrPath}${detail}`,
      res.status,
      txt,
    );
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const { body } = await this.getWithHeaders<T>(path, params);
    return body;
  }

  /** Same as get, but also returns the response headers (used to read Link / X-Next-Page for pagination). */
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

  /**
   * multipart/form-data POST (for attachment upload). Do not set Content-Type manually — let fetch auto-add the
   * boundary from the FormData, otherwise a missing boundary leaves the server unable to parse it.
   */
  async postForm<T>(path: string, form: FormData): Promise<T> {
    const url = buildUrl(this.baseUrl, path);
    const res = await fetchWithTimeout(
      this.fetchFn,
      url,
      { method: 'POST', headers: this.authHeaders(), body: form },
      this.timeoutMs,
    );
    if (!res.ok) throw await this.err(res, 'POST', path);
    return (await res.json()) as T;
  }

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
   * GitLab `Link`-header pagination: list endpoints return a JSON array, the next-page address is in `Link: <url>; rel="next"`
   * (carried by both keyset / offset pagination). Follow next page by page until none remains. per_page=100.
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
   * Asset-host auth mode:
   * - `'pat'`: the GitLab instance host this connection belongs to — fetch with PAT (private assets need auth);
   * - `'public'`: public avatar CDN (gravatar) — when a GitLab user has not set a custom avatar, `avatar_url` points
   *   here; it is a public image, fetched directly over the public internet and **never with PAT** (prevents token leak to third parties);
   * - `null`: any other external host — not proxy-fetched (prevents SSRF), no credentials.
   * An arbitrary external image URL planted by an attacker in a comment falls into the `null` branch — neither fetched nor credentialed.
   */
  private assetHostMode(host: string): 'pat' | 'public' | null {
    if (host === new URL(this.baseUrl).host) return 'pat';
    if (host === 'gravatar.com' || host === 'www.gravatar.com' || host === 'secure.gravatar.com') {
      return 'public';
    }
    return null;
  }

  /**
   * Fetch a binary resource (avatar / comment-embedded attachment). url is a full http(s). **Only proxy this instance's host**
   * (fetch private resources with PAT); public CDN (gravatar) is fetched directly over the public internet without PAT;
   * non-allowlisted hosts return null directly (do not send out PAT, do not proxy-fetch arbitrary URLs). non-2xx / exception → null to let the upper layer fall back.
   */
  async getBinary(url: string): Promise<BinaryResource | null> {
    if (!/^https?:\/\//.test(url)) return null;
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return null;
    }
    const mode = this.assetHostMode(host);
    if (!mode) return null;
    return this.fetchBinary(url, mode === 'pat');
  }

  /**
   * Fetch a binary from an API-relative path (always this instance + PAT). Used for the API download endpoint of
   * private-project markdown uploads `GET /projects/:id/uploads/:secret/:filename` (GitLab 17.4+; older versions lack this route → 404 → null).
   * The upload web route `/<ns>/<proj>/uploads/...` always 302s a PAT to the sign-in page, so private uploads can only go through the API.
   */
  async getApiBinary(path: string): Promise<BinaryResource | null> {
    return this.fetchBinary(buildUrl(this.baseUrl, path), true);
  }

  private async fetchBinary(url: string, withPat: boolean): Promise<BinaryResource | null> {
    // This instance / API assets carry PAT; public CDN (gravatar) never carries PAT, avoiding sending the token to third parties.
    const headers: Record<string, string> = { Accept: 'image/*,*/*;q=0.5' };
    if (withPat) headers['PRIVATE-TOKEN'] = this.token;
    let res: Response;
    try {
      res = await fetchWithTimeout(this.fetchFn, url, { method: 'GET', headers }, this.timeoutMs);
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    // text/html = login redirect / error page (e.g. private-upload web route 302→sign_in), not an asset → null,
    // avoiding stuffing HTML into a data URL as an image that renders as a broken icon.
    if (contentType.toLowerCase().startsWith('text/html')) return null;
    const buf = await res.arrayBuffer();
    return { bytes: new Uint8Array(buf), contentType };
  }
}
