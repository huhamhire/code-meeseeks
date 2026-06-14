export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitLabClientOptions {
  /**
   * GitLab REST API v4 base，无尾斜杠。gitlab.com: `https://gitlab.com/api/v4`；
   * Self-Managed: `https://<host>/api/v4`。
   */
  baseUrl: string;
  /** GitLab Personal Access Token（scope: api，或只读场景 read_api + 写操作另需 api） */
  token: string;
  /** 测试 / 注入用；默认使用全局 fetch */
  fetch?: FetchLike;
  /** 单请求超时（默认 30s） */
  timeoutMs?: number;
}

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
 * 极薄的 GitLab REST v4 客户端：`PRIVATE-TOKEN` PAT 鉴权、`Link` 头分页迭代器、二进制拉取、
 * 错误抛 GitLabClientError。业务语义留给 GitLabAdapter。
 *
 * path 以 `/` 开头时拼 baseUrl；传入完整 http(s) URL 时原样请求（分页 next / 头像 / 附件等用）。
 */
export class GitLabClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: GitLabClientOptions) {
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

  private authHeaders(): Record<string, string> {
    // GitLab PAT 走 PRIVATE-TOKEN 头（OAuth token 才用 Authorization: Bearer）。
    return { 'PRIVATE-TOKEN': this.token, Accept: ACCEPT };
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

  private async err(res: Response, method: string, urlOrPath: string): Promise<GitLabClientError> {
    const txt = await res.text().catch(() => '');
    // GitLab 错误体是 JSON：`{message}` 或 `{error}`（部分端点）。带进错误信息便于上层定位
    // （如合并 405「Method Not Allowed」/ 审批 403「approval ... not available」）。
    let apiMsg = '';
    try {
      const parsed = JSON.parse(txt) as { message?: unknown; error?: unknown };
      const m = parsed.message ?? parsed.error;
      if (typeof m === 'string') apiMsg = m;
      else if (m && typeof m === 'object') apiMsg = JSON.stringify(m);
    } catch {
      /* 非 JSON 响应体，忽略 */
    }
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

  /** 同 get，但同时返回响应头（分页读 Link / X-Next-Page 用）。 */
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
   * GitLab `Link` 头分页：列表端点返回 JSON 数组，下一页地址在 `Link: <url>; rel="next"`
   * （keyset / offset 分页都带）。逐页跟 next 直到没有。per_page=100。
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
   * 判断目标 host 是否为本连接所属 GitLab 实例 host —— 只有同实例资产才会带 PAT。
   * 评论里攻击者放的外部图片 URL 一律不带凭据（防 PAT 外泄）、也不代拉（防 SSRF）。
   */
  private isTrustedAssetHost(host: string): boolean {
    return host === new URL(this.baseUrl).host;
  }

  /**
   * 拉二进制资源（头像 / 评论内嵌附件）。url 为完整 http(s)。**只代理本实例 host**（带 PAT 取私有
   * 资源）；非本实例 host 直接返回 null（不外发 PAT、不代拉任意 URL）。非 2xx / 异常 → null 让上层 fallback。
   */
  async getBinary(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    if (!/^https?:\/\//.test(url)) return null;
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return null;
    }
    if (!this.isTrustedAssetHost(host)) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'GET',
        headers: { 'PRIVATE-TOKEN': this.token, Accept: 'image/*,*/*;q=0.5' },
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
