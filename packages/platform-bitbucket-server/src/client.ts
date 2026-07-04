import type { RepoRef } from '@meebox/shared';
import {
  buildUrl,
  fetchWithTimeout,
  resolveConnectionFetch,
  stripTrailingSlash,
  type BinaryResource,
  type FetchLike,
  type PlatformConnectionConfig,
  type PlatformTransport,
} from '@meebox/platform-core';

/** Bitbucket connection config = unified connection config + clone protocol (connection-layer config managed by the connection layer, not HTTP transport details). */
export interface BitbucketClientOptions extends PlatformConnectionConfig {
  /** clone protocol: 'pat' (default) uses HTTPS + username:PAT; 'ssh' uses the system ssh config */
  cloneProtocol?: 'pat' | 'ssh';
}

/** Adapter constructor options have the same shape as the connection config. */
export type BitbucketServerAdapterOptions = BitbucketClientOptions;

export type { FetchLike } from '@meebox/platform-core';

interface BitbucketPagedResponse<T> {
  values: T[];
  size: number;
  isLastPage: boolean;
  nextPageStart?: number;
  start: number;
  limit: number;
}

export class BitbucketClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'BitbucketClientError';
  }
}

/**
 * Ultra-thin Bitbucket Server REST client implementing {@link PlatformTransport}: Bearer PAT auth,
 * start/limit pagination iterator, throws BitbucketClientError on HTTP errors. Generic transport
 * boilerplate (timeout / URL joining / effective fetch resolution) reuses `@meebox/platform-core`
 * helpers; Bitbucket-specific parts (start/limit pagination, avatar path binary, attachment protocol
 * parsing) stay in this class. Business semantics are left to BitbucketServerAdapter.
 */
export class BitbucketClient implements PlatformTransport {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly cloneProtocol: 'pat' | 'ssh';

  constructor(opts: BitbucketClientOptions) {
    this.baseUrl = stripTrailingSlash(opts.baseUrl);
    this.token = opts.token;
    // Connection layer uniformly resolves the effective fetch (explicit fetch override > proxy > direct).
    this.fetchFn = resolveConnectionFetch(opts);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.cloneProtocol = opts.cloneProtocol ?? 'pat';
  }

  /** Instance web/git base (Bitbucket's API and web share the same host); used for commit detail page URLs etc. */
  get webBase(): string {
    return this.baseUrl;
  }

  /**
   * Construct the git clone URL.
   *
   * ssh → `git@<host>:<proj>/<repo>.git` (port / private key / username handled by the system ssh config;
   * Bitbucket's default SSH port 7999 requires configuring Port yourself). pat →
   * `https://<currentUser>:<PAT>@<host>/scm/<proj>/<repo>.git` (Bitbucket Server's PAT auth requires the
   * real username as username and the PAT as password; requires ping() to have already resolved the current
   * user, passed in by the caller via the connection context, otherwise throws).
   */
  getCloneUrl(repo: RepoRef, currentUserName?: string): string {
    const u = new URL(this.baseUrl);
    if (this.cloneProtocol === 'ssh') {
      return `git@${u.hostname}:${repo.projectKey}/${repo.repoSlug}.git`;
    }
    if (!currentUserName) {
      throw new Error(
        'cannot construct PAT clone URL: current user unknown — ping() not called or failed',
      );
    }
    u.pathname = `/scm/${repo.projectKey}/${repo.repoSlug}.git`;
    u.username = currentUserName;
    u.password = this.token;
    return u.toString();
  }

  private headers(accept = 'application/json', withJsonBody = false): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: accept };
    if (withJsonBody) h['Content-Type'] = 'application/json';
    return h;
  }

  private async raw(method: string, url: string, body?: unknown): Promise<Response> {
    return fetchWithTimeout(
      this.fetchFn,
      url,
      {
        method,
        headers: this.headers('application/json', body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      this.timeoutMs,
    );
  }

  private async err(
    res: Response,
    method: string,
    location: string,
  ): Promise<BitbucketClientError> {
    const body = await res.text().catch(() => '');
    return new BitbucketClientError(
      `${String(res.status)} ${res.statusText} on ${method} ${location}`,
      res.status,
      body,
    );
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const { body } = await this.getWithHeaders<T>(path, params);
    return body;
  }

  /**
   * Fetch a binary resource (avatar.png etc.). On non-2xx, throws BitbucketClientError carrying status /
   * short body, so the caller can distinguish 404 (user has no avatar) vs 401 (auth failure) vs other.
   * content-type is passed through so the renderer can build a data URL.
   */
  async getBinary(path: string, params?: Record<string, string>): Promise<BinaryResource> {
    const url = buildUrl(this.baseUrl, path, params);
    const res = await fetchWithTimeout(
      this.fetchFn,
      url,
      { method: 'GET', headers: this.headers('image/*,*/*;q=0.5') },
      this.timeoutMs,
    );
    if (!res.ok) {
      // Error responses are usually short (HTML / JSON); include up to 200 chars to aid diagnosis
      let body = '';
      try {
        body = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      throw new BitbucketClientError(
        `${String(res.status)} ${res.statusText} on GET ${new URL(url).pathname}`,
        res.status,
        body,
      );
    }
    const buf = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      contentType: res.headers.get('content-type') ?? 'image/png',
    };
  }

  /**
   * Fetch a comment attachment image: handles three url shapes
   *  - `attachment:HASH` (Bitbucket markdown internal protocol) → join with repo into
   *    `<baseUrl>/projects/<key>/repos/<slug>/attachments/<HASH>`
   *  - absolute url (http/https) → validate host matches baseUrl before proxying
   *  - relative url → join with baseUrl
   * Cross-host public image / protocol unparseable / failure / non-2xx → return null so the caller can fall back.
   * All Bitbucket-specific parsing logic is done inside the client; the adapter does not expose the details
   */
  async getAttachmentBinary(
    url: string,
    repo?: { projectKey: string; repoSlug: string },
  ): Promise<BinaryResource | null> {
    let absoluteUrl: string;
    try {
      const myHost = new URL(this.baseUrl).host;
      if (url.startsWith('attachment:')) {
        // Bitbucket markdown attachment protocol `attachment:<repoId>/<attachmentId>` (e.g.,
        // `attachment:9/16854`). Bitbucket's actual attachment endpoint:
        //   /rest/api/1.0/projects/<key>/repos/<slug>/attachments/<attachmentId>
        // (reverse-engineered from Bitbucket Web UI <img src>; uses 1.0 not latest, no /contents suffix)
        // Only the last segment is the attachmentId; the repoId prefix is replaced by the repo ref
        if (!repo) return null;
        const hash = url.slice('attachment:'.length).trim();
        if (!hash) return null;
        const attachmentId = hash.split('/').pop() ?? hash;
        absoluteUrl = `${this.baseUrl}/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/attachments/${attachmentId}`;
      } else if (url.startsWith('http://') || url.startsWith('https://')) {
        const parsed = new URL(url);
        if (parsed.host !== myHost) return null;
        absoluteUrl = url;
      } else {
        // Relative path (e.g., /projects/.../attachments/xxx) joined with the current baseUrl
        absoluteUrl = new URL(url, `https://${myHost}`).toString();
      }
    } catch (e) {
      console.warn(`[bb-attachment] URL parse failed src=${url}:`, e);
      return null;
    }

    let res: Response;
    try {
      res = await fetchWithTimeout(
        this.fetchFn,
        absoluteUrl,
        { method: 'GET', headers: this.headers('image/*,*/*;q=0.5') },
        this.timeoutMs,
      );
    } catch (e) {
      console.warn(`[bb-attachment] fetch threw src=${url} url=${absoluteUrl}:`, e);
      return null;
    }
    if (!res.ok) {
      // No longer silently swallow non-2xx (previously just returned null with no clue). Log status /
      // whether redirected / final URL after redirect / content-type — cross-origin redirects drop the
      // Authorization header (fetch spec), and an unrecognized PAT often returns a 200 login page; this
      // line pinpoints those failure modes.
      console.warn(
        `[bb-attachment] 取附件失败 src=${url} url=${absoluteUrl} status=${String(res.status)} redirected=${String(res.redirected)} finalUrl=${res.url} contentType=${res.headers.get('content-type') ?? '(none)'}`,
      );
      return null;
    }
    const buf = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  /**
   * Same as get, but also returns the response headers. Bitbucket's `X-AUSERNAME` / `X-AUSERID` are in
   * the response headers of every authenticated request, a reliable path for getting the current user during ping.
   */
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

  /**
   * POST with a JSON body. Bitbucket comment reply / new comment use POST /comments. On error, like PUT,
   * throws BitbucketClientError with status + body
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.raw('POST', buildUrl(this.baseUrl, path), body);
    if (!res.ok) throw await this.err(res, 'POST', path);
    return (await res.json()) as T;
  }

  /**
   * multipart/form-data POST (for attachment upload). Do not set Content-Type manually (let fetch add the
   * boundary from FormData); attachment upload must carry `X-Atlassian-Token: no-check` to bypass XSRF
   * validation (a general requirement of Atlassian file-upload endpoints).
   *
   * Accept must use the wildcard (star/slash/star), **not** an explicit `application/json`: the attachment
   * servlet (behind nginx) does content negotiation on this endpoint, and an explicit `application/json`
   * request gets a 405 (`Allow: OPTIONS`) — even though it responds with JSON anyway. The response is still
   * parsed as JSON. (curl uses a wildcard Accept by default and thus succeeds, which once masked this pitfall.)
   */
  async postForm<T>(path: string, form: FormData): Promise<T> {
    const url = buildUrl(this.baseUrl, path);
    const res = await fetchWithTimeout(
      this.fetchFn,
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: '*/*',
          'X-Atlassian-Token': 'no-check',
        },
        body: form,
      },
      this.timeoutMs,
    );
    if (!res.ok) throw await this.err(res, 'POST', path);
    return (await res.json()) as T;
  }

  /**
   * PUT with a JSON body. Bitbucket's PR participant status is written via PUT participants/{slug};
   * errors like 404 / 401 / 409 throw BitbucketClientError with status + body, and the caller decides
   * whether to degrade or rethrow. Returns null when the response body fails JSON parsing (some endpoints
   * return 204 No Content).
   */
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

  /**
   * DELETE without a body. Used for Bitbucket mutations like deleting a comment / removing a reviewer.
   * Query is joined directly onto the path (e.g., `?version=3`), consistent with GET. On error throws
   * BitbucketClientError; on success (204) just returns, no response body needed
   */
  async del(path: string): Promise<void> {
    const res = await this.raw('DELETE', buildUrl(this.baseUrl, path));
    if (!res.ok) throw await this.err(res, 'DELETE', path);
  }

  /**
   * Bitbucket Server standard pagination: start / limit / isLastPage / nextPageStart.
   * Default limit=50; iterates until isLastPage.
   */
  async *paginate<T>(
    path: string,
    params: Record<string, string> = {},
    limit = 50,
  ): AsyncIterable<T> {
    let start = 0;
    while (true) {
      const page = await this.get<BitbucketPagedResponse<T>>(path, {
        ...params,
        start: String(start),
        limit: String(limit),
      });
      for (const v of page.values) yield v;
      if (page.isLastPage) return;
      start = page.nextPageStart ?? start + limit;
    }
  }
}
