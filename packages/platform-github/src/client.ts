export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubClientOptions {
  /**
   * GitHub REST API base，无尾斜杠。github.com: `https://api.github.com`；
   * GHE Server: `https://<host>/api/v3`。
   */
  baseUrl: string;
  /** GitHub Personal Access Token（classic 或 fine-grained） */
  token: string;
  /** 测试 / 注入用；默认使用全局 fetch */
  fetch?: FetchLike;
  /** 单请求超时（默认 30s） */
  timeoutMs?: number;
}

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
 * 极薄的 GitHub REST 客户端：Bearer PAT 鉴权、`Link` 头分页迭代器、二进制拉取、
 * 错误抛 GitHubClientError。业务语义留给 GitHubAdapter。
 *
 * path 以 `/` 开头时拼 baseUrl；传入完整 http(s) URL 时原样请求（分页 next / 头像等用）。
 */
export class GitHubClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: GitHubClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private buildUrl(path: string, params?: Record<string, string>): string {
    const u = /^https?:\/\//.test(path) ? new URL(path) : new URL(`${this.baseUrl}${path}`);
    if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  private authHeaders(accept = ACCEPT): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: accept,
      'X-GitHub-Api-Version': API_VERSION,
    };
  }

  private async raw(method: string, url: string, body?: unknown): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, {
        method,
        headers:
          body === undefined
            ? this.authHeaders()
            : { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async err(res: Response, method: string, urlOrPath: string): Promise<GitHubClientError> {
    const txt = await res.text().catch(() => '');
    // 限流（403/429 + X-RateLimit-Remaining: 0）给更可读的提示，便于上层节流
    const remaining = res.headers.get('x-ratelimit-remaining');
    const rateLimited = (res.status === 403 || res.status === 429) && remaining === '0';
    const hint = rateLimited ? '（GitHub API 限流，请稍后重试）' : '';
    return new GitHubClientError(
      `${String(res.status)} ${res.statusText} on ${method} ${urlOrPath}${hint}`,
      res.status,
      txt,
    );
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const { body } = await this.getWithHeaders<T>(path, params);
    return body;
  }

  /** 同 get，但同时返回响应头（ping 读 GHE 版本 / 分页读 Link 用）。 */
  async getWithHeaders<T>(
    path: string,
    params?: Record<string, string>,
  ): Promise<{ body: T; headers: Headers }> {
    const url = this.buildUrl(path, params);
    const res = await this.raw('GET', url);
    if (!res.ok) throw await this.err(res, 'GET', new URL(url).pathname);
    const body = (await res.json()) as T;
    return { body, headers: res.headers };
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const url = this.buildUrl(path);
    const res = await this.raw('POST', url, body);
    if (!res.ok) throw await this.err(res, 'POST', path);
    return (await res.json()) as T;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const url = this.buildUrl(path);
    const res = await this.raw('PATCH', url, body);
    if (!res.ok) throw await this.err(res, 'PATCH', path);
    return (await res.json()) as T;
  }

  /** PUT；部分端点（merge / dismissals）返回 JSON，留空时返回 null。 */
  async put<T>(path: string, body: unknown): Promise<T | null> {
    const url = this.buildUrl(path);
    const res = await this.raw('PUT', url, body);
    if (!res.ok) throw await this.err(res, 'PUT', path);
    if (res.status === 204) return null;
    try {
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  async del(path: string): Promise<void> {
    const url = this.buildUrl(path);
    const res = await this.raw('DELETE', url);
    if (!res.ok) throw await this.err(res, 'DELETE', path);
  }

  /**
   * GitHub `Link` 头分页：列表端点返回 JSON 数组，下一页地址在 `Link: <url>; rel="next"`。
   * 逐页跟 next 直到没有。per_page=100。
   */
  async *paginate<T>(path: string, params: Record<string, string> = {}): AsyncIterable<T> {
    let url: string | null = this.buildUrl(path, { per_page: '100', ...params });
    while (url) {
      const res = await this.raw('GET', url);
      if (!res.ok) throw await this.err(res, 'GET', new URL(url).pathname);
      const items = (await res.json()) as T[];
      for (const it of items) yield it;
      url = parseNextLink(res.headers.get('link'));
    }
  }

  /**
   * Search 端点（`/search/issues` 等）：返回 `{ items, total_count }`，分页同样走 Link 头。
   * 注意搜索 30 次/分限流；调用方应节流。
   */
  async *searchItems<T>(path: string, params: Record<string, string>): AsyncIterable<T> {
    let url: string | null = this.buildUrl(path, { per_page: '100', ...params });
    while (url) {
      const res = await this.raw('GET', url);
      if (!res.ok) throw await this.err(res, 'GET', new URL(url).pathname);
      const page = (await res.json()) as { items: T[] };
      for (const it of page.items) yield it;
      url = parseNextLink(res.headers.get('link'));
    }
  }

  /**
   * 拉二进制资源（头像 / 评论内嵌图片）。url 为完整 http(s)。带上鉴权头（私有 GHE
   * 资源需要；公共 CDN 也无害）。非 2xx / 异常 → 返回 null 让上层 fallback。
   */
  async getBinary(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    if (!/^https?:\/\//.test(url)) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'image/*,*/*;q=0.5' },
        signal: ctl.signal,
      });
    } catch {
      clearTimeout(timer);
      return null;
    }
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}

/** 从 `Link` 头解析 `rel="next"` 的 URL；无则 null。 */
export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m) return m[1] ?? null;
  }
  return null;
}
