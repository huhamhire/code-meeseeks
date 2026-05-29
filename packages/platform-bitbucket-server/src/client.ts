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
    return (await res.json()) as T;
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
