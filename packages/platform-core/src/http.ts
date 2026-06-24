import type { FetchLike, PlatformConnectionConfig, ProxyFetchFactory } from './transport.js';

/** 连接层默认单请求超时。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

const globalFetch: FetchLike = (input, init) => fetch(input, init);

/** 去尾斜杠（归一 base URL 用）。 */
export function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/** 取 URL 的 host；解析失败返回空串。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * 拼请求 URL：`path` 以 http(s) 开头时原样请求（分页 next / 绝对资源 URL）；否则拼到 `baseUrl` 之后。
 * 可选 query 写进 searchParams。
 */
export function buildUrl(
  baseUrl: string,
  path: string,
  params?: Record<string, string>,
): string {
  const u = /^https?:\/\//.test(path) ? new URL(path) : new URL(`${baseUrl}${path}`);
  if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** 带超时（AbortController）的 fetch；超时即 abort。`init.signal` 由本函数注入，调用方勿自带。 */
export async function fetchWithTimeout(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 从 `Link` 头解析 `rel="next"` 的 URL；无则 null（GitHub / GitLab 的 Link 头分页共用）。 */
export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m) return m[1] ?? null;
  }
  return null;
}

/** 收集异步迭代器为数组。 */
export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

/**
 * 从错误响应体（JSON）提取 API 给的真因消息。识别 `{message}`（GitHub / Bitbucket）与 `{error}`
 * （GitLab 部分端点）；对象型 message 序列化为字符串。非 JSON 响应体 → 空串。
 */
export function extractApiMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
    const m = parsed.message ?? parsed.error;
    if (typeof m === 'string') return m;
    if (m && typeof m === 'object') return JSON.stringify(m);
  } catch {
    /* 非 JSON 响应体，忽略 */
  }
  return '';
}

/**
 * 解析连接层有效 fetch，把代理解析统一收口到连接层（替代各调用点手拼 `proxyFetchForHost`）：
 * - 显式 `config.fetch` 覆盖优先（测试桩 / 已自行解析代理）；
 * - 否则按统一 `config.proxy` + `baseUrl` host 经注入的工厂解析；工厂返回 undefined（loopback / 代理
 *   关闭）时退回直连全局 fetch；
 * - 无 proxy / 无工厂 → 直连全局 fetch。
 */
export function resolveConnectionFetch(
  config: PlatformConnectionConfig,
  proxyFetchFor?: ProxyFetchFactory,
): FetchLike {
  if (config.fetch) return config.fetch;
  if (config.proxy && proxyFetchFor) {
    return proxyFetchFor(config.proxy, hostOf(config.baseUrl)) ?? globalFetch;
  }
  return globalFetch;
}
