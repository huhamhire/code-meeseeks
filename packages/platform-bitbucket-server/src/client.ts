export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface BitbucketClientOptions {
  /** 含 scheme + 主机，无尾斜杠。例：https://bb.internal.corp */
  baseUrl: string;
  /** Bitbucket Server Personal Access Token */
  token: string;
  /** 测试 / 注入用；默认使用全局 fetch */
  fetch?: FetchLike;
  /** 单请求超时（默认 30s） */
  timeoutMs?: number;
}

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
 * 极薄的 Bitbucket Server REST 客户端：Bearer PAT 鉴权、查询参数、分页迭代器、HTTP 错误抛 BitbucketClientError。
 * 业务语义留给 BitbucketServerAdapter。
 */
export class BitbucketClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: BitbucketClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const { body } = await this.getWithHeaders<T>(path, params);
    return body;
  }

  /**
   * 拉二进制资源（avatar.png 等）。非 2xx 时抛 BitbucketClientError 携带 status / 简短
   * body，方便调用方区分 404（用户无头像）vs 401（鉴权失败）vs 其他。content-type
   * 透传，方便 renderer 拼 data URL。
   */
  async getBinary(
    path: string,
    params?: Record<string, string>,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'image/*,*/*;q=0.5',
        },
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // 错误响应通常很短（HTML / JSON），尽量带 100 字便于诊断
      let body = '';
      try {
        body = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      throw new BitbucketClientError(
        `${String(res.status)} ${res.statusText} on GET ${url.pathname}`,
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
   * 拉评论 attachment 图片：处理三种 url 形态
   *  - `attachment:HASH` (Bitbucket markdown 内部协议) → 用 repo 拼成
   *    `<baseUrl>/projects/<key>/repos/<slug>/attachments/<HASH>`
   *  - 绝对 url (http/https) → 校验 host 跟 baseUrl 一致才走代理
   *  - 相对 url → 拼 baseUrl
   * 跨 host 公网图 / 协议无法解析 / 失败 / 非 2xx → 返回 null 让上层 fallback。
   * 所有 Bitbucket-specific 解析逻辑都在 client 内部完成，adapter 不暴露细节
   */
  async getAttachmentBinary(
    url: string,
    repo?: { projectKey: string; repoSlug: string },
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    let absoluteUrl: string;
    try {
      const myHost = new URL(this.baseUrl).host;
      if (url.startsWith('attachment:')) {
        // Bitbucket markdown 附件协议 `attachment:<repoId>/<attachmentId>` (e.g.,
        // `attachment:9/16854`)。Bitbucket 实际 attachment endpoint:
        //   /rest/api/1.0/projects/<key>/repos/<slug>/attachments/<attachmentId>
        // (从 Bitbucket Web UI <img src> 反推；用 1.0 而非 latest，无 /contents 后缀)
        // 末段才是 attachmentId，前缀 repoId 用 repo ref 取代
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
        // 相对路径 (e.g., /projects/.../attachments/xxx) 拼当前 baseUrl
        absoluteUrl = new URL(url, `https://${myHost}`).toString();
      }
    } catch {
      return null;
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(absoluteUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'image/*,*/*;q=0.5',
        },
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

  /**
   * 同 get，但同时返回响应头。Bitbucket 的 `X-AUSERNAME` / `X-AUSERID` 在每个鉴权
   * 请求的响应头里，是 ping 时拿当前用户的可靠路径。
   */
  async getWithHeaders<T>(
    path: string,
    params?: Record<string, string>,
  ): Promise<{ body: T; headers: Headers }> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
        },
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new BitbucketClientError(
        `${String(res.status)} ${res.statusText} on GET ${url.pathname}`,
        res.status,
        body,
      );
    }
    const body = (await res.json()) as T;
    return { body, headers: res.headers };
  }

  /**
   * 带 JSON body 的 POST。Bitbucket 评论 reply / 新建评论用 POST /comments。错误同 PUT
   * 抛 BitbucketClientError 附 status + body
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new BitbucketClientError(
        `${String(res.status)} ${res.statusText} on POST ${path}`,
        res.status,
        txt,
      );
    }
    return (await res.json()) as T;
  }

  /**
   * 带 JSON body 的 PUT。Bitbucket 的 PR 参与者 status 用 PUT participants/{slug} 写入，
   * 404 / 401 / 409 等错误抛 BitbucketClientError 并附 status + body，调用方决定降级或抛出。
   * 响应体 JSON 解析失败时返回 unknown（部分端点返回 204 No Content）。
   */
  async put<T>(path: string, body: unknown): Promise<T | null> {
    const url = `${this.baseUrl}${path}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new BitbucketClientError(
        `${String(res.status)} ${res.statusText} on PUT ${path}`,
        res.status,
        txt,
      );
    }
    if (res.status === 204) return null;
    try {
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  /**
   * 无 body 的 DELETE。Bitbucket 删评论 / 删 reviewer 等 mutations 用。query 通过 path
   * 直接拼 (e.g., `?version=3`)，跟 GET 一致。错误抛 BitbucketClientError；成功 (204)
   * 直接 return，不需要响应体
   */
  async del(path: string): Promise<void> {
    const url = `${this.baseUrl}${path}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
        },
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new BitbucketClientError(
        `${String(res.status)} ${res.statusText} on DELETE ${path}`,
        res.status,
        txt,
      );
    }
  }

  /**
   * Bitbucket Server 标准分页：start / limit / isLastPage / nextPageStart。
   * 默认 limit=50；遍历直至 isLastPage。
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
