// 出站网络代理 plumbing。读 config.proxy，产出三种形态：
//   - buildProxyEnv：子进程 env（给 ① pr-agent、③ git HTTPS，litellm/git 认 HTTP(S)_PROXY）
//   - buildProxyDispatcher：undici ProxyAgent（给 ② Bitbucket Server REST 的 fetch）
//   - shouldBypass：loopback/本地是否直连（② 在调用点据此决定要不要挂 dispatcher）
// 一期仅 HTTP 代理；enabled=false 时全部产出「空/直连」，调用点无需各自判断开关。
import { ProxyAgent, type Dispatcher } from 'undici';
import type { ProxyConfig } from '@meebox/shared';

// loopback / 本地：始终直连，不经代理。env 路径靠 NO_PROXY，dispatcher 路径靠 shouldBypass。
const NO_PROXY = 'localhost,127.0.0.1,::1';

/** loopback / 本地 host → true（应直连，不走代理）。 */
export function shouldBypass(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ''); // 去掉 IPv6 字面量方括号
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1';
}

/** 拼标准代理 URL：`<protocol>://[user:pass@]host:port`。关闭 / 无 host 时 undefined。 */
export function proxyUrl(proxy: ProxyConfig): string | undefined {
  if (!proxy.enabled || !proxy.host) return undefined;
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : '';
  return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
}

/**
 * 子进程 env：HTTP_PROXY/HTTPS_PROXY/ALL_PROXY + NO_PROXY（大小写都给——不同库读法不一，
 * httpx/git/curl 多认小写，部分认大写）。NO_PROXY 把 loopback/本地排除在代理外。
 * 关闭时返回 {}，调用点 spread 即无副作用。
 */
export function buildProxyEnv(proxy: ProxyConfig): Record<string, string> {
  const url = proxyUrl(proxy);
  if (!url) return {};
  return {
    HTTP_PROXY: url,
    http_proxy: url,
    HTTPS_PROXY: url,
    https_proxy: url,
    ALL_PROXY: url,
    all_proxy: url,
    NO_PROXY,
    no_proxy: NO_PROXY,
  };
}

/**
 * undici ProxyAgent（含 Basic Auth，凭据嵌在 URL）。关闭时 undefined。
 * 注意：ProxyAgent 自身不认 NO_PROXY —— loopback 绕过由调用点先过 shouldBypass 决定。
 */
export function buildProxyDispatcher(proxy: ProxyConfig): Dispatcher | undefined {
  const url = proxyUrl(proxy);
  if (!url) return undefined;
  return new ProxyAgent(url);
}

// 测试连通用的中性外部端点：返回 204、体积极小。代理能转发到它即说明出网正常。
const PROXY_TEST_URL = 'https://www.google.com/generate_204';

/**
 * 用给定代理配置试连一个外部地址，验证代理是否可用（设置页「测试连通」）。
 * 拿到任意 HTTP 响应即视为代理转发成功；407 视为认证失败；超时/网络错误归一成 reason。
 */
export async function testProxyConnectivity(
  proxy: ProxyConfig,
): Promise<{ ok: boolean; reason?: string }> {
  const dispatcher = buildProxyDispatcher(proxy);
  if (!dispatcher) return { ok: false, reason: '代理未启用或地址为空' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(PROXY_TEST_URL, {
      signal: ctrl.signal,
      dispatcher,
    } as RequestInit & { dispatcher: Dispatcher });
    if (res.status === 407) return { ok: false, reason: '代理认证失败 (407)，检查用户名/密码' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 给某目标 host 造一个「代理感知」的 fetch，注入 BitbucketClient 的 opts.fetch。
 * host 命中 loopback/本地 → 返回 undefined（调用点用默认全局 fetch 直连）。
 * 否则返回带 dispatcher 的 fetch 包装。代理关闭也返回 undefined。
 */
export function proxyFetchForHost(
  proxy: ProxyConfig,
  host: string,
): ((input: string, init?: RequestInit) => Promise<Response>) | undefined {
  if (shouldBypass(host)) return undefined;
  const dispatcher = buildProxyDispatcher(proxy);
  if (!dispatcher) return undefined;
  return (input, init) =>
    fetch(input, { ...init, dispatcher } as RequestInit & { dispatcher: Dispatcher });
}
