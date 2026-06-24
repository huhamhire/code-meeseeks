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

/** GitHub 连接配置 = 统一连接配置（baseUrl / token / timeoutMs / proxy / fetch）。 */
export type GitHubClientOptions = PlatformConnectionConfig;

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
 * 极薄的 GitHub REST 客户端，实现 {@link PlatformTransport}：Bearer PAT 鉴权、`Link` 头分页迭代器、
 * 二进制拉取、错误抛 GitHubClientError。通用传输样板（超时 / URL 拼接 / 错误消息提取 / Link 分页）
 * 复用 `@meebox/platform-core` helper；GitHub 特有部分（鉴权头 / 限流提示 / 可信资产域 / search /
 * patch）留在本类。业务语义留给 GitHubAdapter。
 *
 * path 以 `/` 开头时拼 baseUrl；传入完整 http(s) URL 时原样请求（分页 next / 头像等用）。
 */
export class GitHubClient implements PlatformTransport {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: GitHubClientOptions) {
    this.baseUrl = stripTrailingSlash(opts.baseUrl);
    this.token = opts.token;
    // 连接层统一解析有效 fetch（显式 fetch 覆盖 > 代理 > 直连）。
    this.fetchFn = resolveConnectionFetch(opts);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
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
    // GitHub 错误体是 JSON，message 才是真因（如合并 405「Pull Request is not mergeable」）。
    const apiMsg = extractApiMessage(txt);
    const detail = apiMsg ? `：${apiMsg}` : '';
    // 限流（403/429 + X-RateLimit-Remaining: 0）给更可读的提示，便于上层节流。
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

  /** 同 get，但同时返回响应头（ping 读 GHE 版本 / 分页读 Link 用）。 */
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

  /** PUT；部分端点（merge / dismissals）返回 JSON，留空时返回 null。 */
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
   * GitHub `Link` 头分页：列表端点返回 JSON 数组，下一页地址在 `Link: <url>; rel="next"`。
   * 逐页跟 next 直到没有。per_page=100。
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
   * Search 端点（`/search/issues` 等）：返回 `{ items, total_count }`，分页同样走 Link 头。
   * 注意搜索 30 次/分限流；调用方应节流。
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
   * 判断目标 host 是否为本连接可信的 GitHub/GHE 资产域 —— 只有可信域才会带 PAT。
   * github.com：api.github.com + github.com + *.githubusercontent.com（头像 / user-attachments
   * 等都在此）。GHE：实例 host 及其子域（媒体资产常在同实例下）。其余（评论里攻击者放的外部
   * 图片 URL）一律不带凭据，避免 PAT 被外发泄露。
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
    // GHE：实例同 host 或其子域
    return host === apiHost || host.endsWith(`.${apiHost}`);
  }

  /**
   * 拉二进制资源（头像 / 评论内嵌图片）。url 为完整 http(s)。**只代理可信 GitHub/GHE 资产域**
   * （带 PAT 取私有资源）；非可信 host（如评论里攻击者放的外部图片 URL）直接返回 null —— 既不
   * 外发 PAT（防泄露），也不让主进程去代拉任意外部 URL（防 SSRF），交渲染层退回原生 <img> 加载。
   * 非 2xx / 异常 → 同样返回 null 让上层 fallback。
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
