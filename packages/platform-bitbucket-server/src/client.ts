export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface BBClientOptions {
  /** 含 scheme + 主机，无尾斜杠。例：https://bb.internal.corp */
  baseUrl: string;
  /** Bitbucket Server Personal Access Token */
  token: string;
  /** 测试 / 注入用；默认使用全局 fetch */
  fetch?: FetchLike;
  /** 单请求超时（默认 30s） */
  timeoutMs?: number;
}

interface BBPagedResponse<T> {
  values: T[];
  size: number;
  isLastPage: boolean;
  nextPageStart?: number;
  start: number;
  limit: number;
}

export class BBClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'BBClientError';
  }
}

/**
 * 极薄的 Bitbucket Server REST 客户端：Bearer PAT 鉴权、查询参数、分页迭代器、HTTP 错误抛 BBClientError。
 * 业务语义留给 BitbucketServerAdapter。
 */
export class BBClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: BBClientOptions) {
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
   * 拉二进制资源（avatar.png 等）。非 2xx 时抛 BBClientError 携带 status / 简短
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
      throw new BBClientError(
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
   * 同 get，但同时返回响应头。BBS 的 `X-AUSERNAME` / `X-AUSERID` 在每个鉴权
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
      throw new BBClientError(
        `${String(res.status)} ${res.statusText} on GET ${url.pathname}`,
        res.status,
        body,
      );
    }
    const body = (await res.json()) as T;
    return { body, headers: res.headers };
  }

  /**
   * 带 JSON body 的 PUT。BBS 的 PR 参与者 status 用 PUT participants/{slug} 写入，
   * 404 / 401 / 409 等错误抛 BBClientError 并附 status + body，调用方决定降级或抛出。
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
      throw new BBClientError(
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
      const page = await this.get<BBPagedResponse<T>>(path, {
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
