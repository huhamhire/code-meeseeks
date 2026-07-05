// Outbound network proxy plumbing. Reads config.proxy and produces three forms:
//   - buildProxyEnv: child-process env (for ① pr-agent, ③ git HTTPS; litellm/git honor HTTP(S)_PROXY)
//   - buildProxyDispatcher: undici ProxyAgent (for ② the fetch to Bitbucket Server REST)
//   - shouldBypass: whether loopback/local goes direct (② decides at the call site whether to attach a dispatcher)
// Phase one is HTTP proxy only; when enabled=false all forms yield "empty/direct connection", so call sites need not each check the switch.
import { ProxyAgent, type Dispatcher } from 'undici';
import { ERROR_CODES, errorCodeMessage, type ProxyConfig } from '@meebox/shared';

// loopback / local: always direct connection, never through the proxy. The env path relies on NO_PROXY, the dispatcher path on shouldBypass.
const NO_PROXY = 'localhost,127.0.0.1,::1';

/** loopback / local host → true (should go direct connection, not through the proxy). */
export function shouldBypass(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 literal brackets
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1';
}

/** Build a standard proxy URL: `<protocol>://[user:pass@]host:port`. undefined when disabled / no host. */
export function proxyUrl(proxy: ProxyConfig): string | undefined {
  if (!proxy.enabled || !proxy.host) return undefined;
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : '';
  return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
}

/**
 * Child-process env: HTTP_PROXY/HTTPS_PROXY/ALL_PROXY + NO_PROXY (both cases given — libraries read differently,
 * httpx/git/curl mostly honor lowercase, some honor uppercase). NO_PROXY excludes loopback/local from the proxy.
 * Returns {} when disabled, so spreading at the call site has no side effect.
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
 * undici ProxyAgent (includes Basic Auth, credentials embedded in the URL). undefined when disabled.
 * Note: ProxyAgent itself does not honor NO_PROXY — loopback bypass is decided by the call site running shouldBypass first.
 */
export function buildProxyDispatcher(proxy: ProxyConfig): Dispatcher | undefined {
  const url = proxyUrl(proxy);
  if (!url) return undefined;
  return new ProxyAgent(url);
}

// Neutral external endpoint for connectivity testing: returns 204, extremely small. If the proxy can forward to it, outbound networking works.
const PROXY_TEST_URL = 'https://www.google.com/generate_204';

/**
 * Try connecting to an external address with the given proxy config to verify the proxy is usable (the settings page "test connectivity").
 * Any HTTP response counts as a successful proxy forward; 407 counts as auth failure; timeout/network errors are normalized into reason.
 */
export async function testProxyConnectivity(
  proxy: ProxyConfig,
): Promise<{ ok: boolean; reason?: string }> {
  const dispatcher = buildProxyDispatcher(proxy);
  if (!dispatcher) return { ok: false, reason: errorCodeMessage(ERROR_CODES.NT_PROXY_DISABLED) };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(PROXY_TEST_URL, {
      signal: ctrl.signal,
      dispatcher,
    } as RequestInit & { dispatcher: Dispatcher });
    if (res.status === 407)
      return { ok: false, reason: errorCodeMessage(ERROR_CODES.NT_PROXY_AUTH_FAILED) };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a "proxy-aware" fetch for a target host, to inject into BitbucketClient's opts.fetch.
 * host hits loopback/local → returns undefined (the call site uses the default global fetch for a direct connection).
 * Otherwise returns a fetch wrapper carrying the dispatcher. Also returns undefined when the proxy is disabled.
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
