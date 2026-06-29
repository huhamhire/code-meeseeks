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

/** GitLab 连接配置 = 统一连接配置 + clone 协议（连接层自管的连接配置，非 HTTP 传输细节）。 */
export interface GitLabClientOptions extends PlatformConnectionConfig {
  /** clone 协议：'pat'（默认）走 HTTPS + 用户名:PAT；'ssh' 走系统 ssh 配置 */
  cloneProtocol?: 'pat' | 'ssh';
}

/** 适配器构造选项与连接配置同形。 */
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
 * 容错归一 GitLab API base：用户可只填实例地址（`https://gitlab.example.com`）或完整
 * `.../api/v4`；统一补足 `/api/v4`（已带 `/api/vN` 则原样）。免去用户记忆 API 路径。
 */
export function normalizeGitLabApiBase(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  return /\/api\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/api/v4`;
}

/**
 * 极薄的 GitLab REST v4 客户端，实现 {@link PlatformTransport}：`PRIVATE-TOKEN` PAT 鉴权、`Link` 头
 * 分页迭代器、二进制拉取、错误抛 GitLabClientError。通用传输样板（超时 / URL 拼接 / 错误消息提取 /
 * Link 分页 / 有效 fetch 解析）复用 `@meebox/platform-core` helper；GitLab 特有部分（PRIVATE-TOKEN /
 * 资产 host 鉴权模式 / API 二进制端点）留在本类。业务语义留给 GitLabAdapter。
 *
 * path 以 `/` 开头时拼 baseUrl；传入完整 http(s) URL 时原样请求（分页 next / 头像 / 附件等用）。
 */
export class GitLabClient implements PlatformTransport {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly cloneProtocol: 'pat' | 'ssh';
  /** 实例 web/git host（去掉 /api/v4），clone / 附件 / 网页用。 */
  private readonly webBase: string;
  readonly gitHost: string;
  /**
   * MR 审批 API（approve/unapprove）是否可用：自 13.9 起为 Premium/Ultimate，CE / EE-Free 无。
   * 由连接层 ping() 经 /metadata.enterprise 探测后写入；探测前保守置 false（CE）。是该平台连接
   * 探测得到的连接态，故落在连接封装实例上，供连接（capabilities）与 PR（审批拉取）领域共读。
   */
  approvalsAvailable = false;

  constructor(opts: GitLabClientOptions) {
    const apiBase = normalizeGitLabApiBase(opts.baseUrl);
    this.baseUrl = stripTrailingSlash(apiBase);
    this.token = opts.token;
    // 连接层统一解析有效 fetch（显式 fetch 覆盖 > 代理 > 直连）。
    this.fetchFn = resolveConnectionFetch({ ...opts, baseUrl: apiBase });
    this.cloneProtocol = opts.cloneProtocol ?? 'pat';
    const api = new URL(apiBase);
    this.webBase = `${api.protocol}//${api.host}`;
    this.gitHost = api.host;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private authHeaders(): Record<string, string> {
    // GitLab PAT 走 PRIVATE-TOKEN 头（OAuth token 才用 Authorization: Bearer）。
    return { 'PRIVATE-TOKEN': this.token, Accept: ACCEPT };
  }

  /**
   * 构造 git clone URL：ssh → `git@<gitHost>:<group>/<repo>.git`；pat → 在 web host 内嵌
   * `<currentUser>:<PAT>`。pat 需 ping() 已落地当前用户（由调用方经连接上下文传入），否则抛错。
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
    // GitLab 错误体是 JSON：`{message}` 或 `{error}`（部分端点）。带进错误信息便于上层定位
    // （如合并 405「Method Not Allowed」/ 审批 403「approval ... not available」）。
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

  /** 同 get，但同时返回响应头（分页读 Link / X-Next-Page 用）。 */
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
   * multipart/form-data POST（附件上传用）。不手动设 Content-Type——交给 fetch 按 FormData 自动加
   * boundary，否则边界缺失服务端无法解析。
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
   * GitLab `Link` 头分页：列表端点返回 JSON 数组，下一页地址在 `Link: <url>; rel="next"`
   * （keyset / offset 分页都带）。逐页跟 next 直到没有。per_page=100。
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
   * 资产 host 鉴权模式：
   * - `'pat'`：本连接所属 GitLab 实例 host —— 带 PAT 取（私有资产需鉴权）；
   * - `'public'`：公共头像 CDN（gravatar）—— GitLab 用户未设自定义头像时 `avatar_url` 即指向
   *   此，是公开图片，按公网直取且**绝不带 PAT**（防令牌泄露给第三方）；
   * - `null`：其它外部 host —— 不代拉（防 SSRF）、不带凭据。
   * 评论里攻击者放的任意外部图片 URL 落到 `null` 分支，既不取也不带凭据。
   */
  private assetHostMode(host: string): 'pat' | 'public' | null {
    if (host === new URL(this.baseUrl).host) return 'pat';
    if (host === 'gravatar.com' || host === 'www.gravatar.com' || host === 'secure.gravatar.com') {
      return 'public';
    }
    return null;
  }

  /**
   * 拉二进制资源（头像 / 评论内嵌附件）。url 为完整 http(s)。**只代理本实例 host**（带 PAT 取私有
   * 资源）；公共 CDN（gravatar）公网直取不带 PAT；非白名单 host 直接返回 null（不外发 PAT、不代拉
   * 任意 URL）。非 2xx / 异常 → null 让上层 fallback。
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
   * 拉 API 相对路径的二进制（始终本实例 + PAT）。用于私有项目 markdown 上传的 API 下载端点
   * `GET /projects/:id/uploads/:secret/:filename`（GitLab 17.4+；旧版无此路由 → 404 → null）。
   * 上传的 web 路由 `/<ns>/<proj>/uploads/...` 对 PAT 一律 302 到登录页，故私有上传只能走 API。
   */
  async getApiBinary(path: string): Promise<BinaryResource | null> {
    return this.fetchBinary(buildUrl(this.baseUrl, path), true);
  }

  private async fetchBinary(url: string, withPat: boolean): Promise<BinaryResource | null> {
    // 本实例 / API 资产带 PAT；公共 CDN（gravatar）绝不带 PAT，避免把令牌发给第三方。
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
    // text/html = 登录重定向 / 错误页（如私有上传 web 路由 302→sign_in），不是资产 → null，
    // 避免把 HTML 当图片塞进 data URL 显示成损坏图标。
    if (contentType.toLowerCase().startsWith('text/html')) return null;
    const buf = await res.arrayBuffer();
    return { bytes: new Uint8Array(buf), contentType };
  }
}
