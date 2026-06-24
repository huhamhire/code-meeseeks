import type { ProxyConfig } from '@meebox/shared';

/** 可注入的 fetch（测试桩 / 代理包装）；连接层默认用全局 fetch。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 二进制资源（头像 / 附件）：原始字节 + content-type，供 main 端缓存并转 data URL。 */
export interface BinaryResource {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * 代理 fetch 工厂（注入口）。给定统一代理配置与目标 host，产出「代理感知」的 fetch；loopback / 代理
 * 关闭时返回 undefined（连接层退回直连全局 fetch）。把 undici ProxyAgent 等具体传输实现留在注入方
 * （desktop），使 platform-core 不依赖具体代理实现。
 */
export type ProxyFetchFactory = (proxy: ProxyConfig, host: string) => FetchLike | undefined;

/**
 * 平台连接的统一配置。连接层（统一连接封装实例）据此构造——含连接参数、鉴权 token 与**统一的代理
 * 配置**。代理解析（loopback 直连 / 否则挂代理）由连接层据 `baseUrl` host 一次完成，不再由各调用点
 * 预拼 fetch（见 docs/arch/01-platform-adapter.md §1）。
 */
export interface PlatformConnectionConfig {
  /** 平台 REST API base，无尾斜杠。 */
  baseUrl: string;
  /** Personal Access Token；只进连接层、绝不进日志。 */
  token: string;
  /** 单请求超时（默认 30s）。 */
  timeoutMs?: number;
  /** 统一代理配置；连接层据此 + `baseUrl` host 经 `proxyFetch` 解析有效 fetch。 */
  proxy?: ProxyConfig;
  /**
   * 代理 fetch 工厂（注入口）。由组合根（desktop）提供 undici 实现；连接层据 `proxy` + `baseUrl` host
   * 调用它解析代理感知 fetch。未提供则不挂代理（即便 `proxy` 存在也直连）。
   */
  proxyFetch?: ProxyFetchFactory;
  /** 显式 fetch 覆盖（测试桩 / 已自行解析代理）；给定则优先于 `proxy` 解析。 */
  fetch?: FetchLike;
}

/**
 * 平台连接传输端口（port）。领域基类只依赖此接口发起调用，不感知底层 fetch / 鉴权 / 分页 / 错误解析
 * 实现。各平台包提供「统一连接封装实例」实现本端口（见 docs/arch/01-platform-adapter.md §1）。
 *
 * 仅声明三平台同构的**最小连接能力**——纯 JSON 读写 + 分页。平台特有方法（GitHub PATCH / search、各平台
 * 信任模型迥异的二进制拉取等）由各自传输实现作为端口之外的扩展提供，不污染通用契约；二进制资源由
 * MediaService 领域基类按平台抽象（见 §3.2），故不进本端口。
 */
export interface PlatformTransport {
  /** GET，返回 JSON 体。 */
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
  /** GET，返回 JSON 体 + 响应头（读服务端版本 / 当前用户 / 分页头用）。 */
  getWithHeaders<T>(
    path: string,
    params?: Record<string, string>,
  ): Promise<{ body: T; headers: Headers }>;
  /** POST JSON，返回 JSON 体。 */
  post<T>(path: string, body: unknown): Promise<T>;
  /** PUT JSON；部分端点 204 无体，返回 null。 */
  put<T>(path: string, body: unknown): Promise<T | null>;
  /** DELETE，无返回体。 */
  del(path: string): Promise<void>;
  /** 列表分页迭代器（平台各自的分页风格在实现内收口为统一异步迭代）。 */
  paginate<T>(path: string, params?: Record<string, string>): AsyncIterable<T>;
}
