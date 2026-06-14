import { BitbucketServerAdapter } from '@meebox/platform-bitbucket-server';
import { GitHubAdapter } from '@meebox/platform-github';
import { GitLabAdapter } from '@meebox/platform-gitlab';
import {
  GITHUB_DOTCOM_API_BASE,
  GITLAB_DOTCOM_API_BASE,
  type Connection,
  type PlatformAdapter,
  type PlatformKind,
  type ProxyConfig,
} from '@meebox/shared';
import { proxyFetchForHost } from './utils/proxy.js';

export interface BuiltAdapter {
  connectionId: string;
  adapter: PlatformAdapter;
}

/**
 * 可变的连接运行时持有：adapters（全量，IPC 按 id 查任意连接）+ adapterByHost
 * （repo-mirror 按 host 找 adapter 取 clone url）。设置页改连接时 reconfigure 原地替换
 * 内容，IPC handler / repoMirror 经引用读到新值，无需重启。
 */
export interface ConnectionRuntime {
  adapters: BuiltAdapter[];
  adapterByHost: Map<string, PlatformAdapter>;
}

/** 从 base_url 取 host；解析失败返回空串（proxyFetchForHost 对空 host 视为外部、按代理配置处理）。 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return '';
  }
}

/**
 * 用草稿 base_url + token 临时起一个 adapter，仅供设置页 ping 测试用。kind 默认
 * bitbucket-server（向后兼容旧调用）。proxy 透传：开关开且目标非 loopback 时，REST 经代理。
 */
export function buildDraftAdapter(
  baseUrl: string,
  token: string,
  proxy: ProxyConfig,
  kind: PlatformKind = 'bitbucket-server',
): PlatformAdapter {
  if (kind === 'github') {
    // GitHub 草稿 base_url 可留空 → 默认官方 api.github.com
    const ghBase = baseUrl.trim() || GITHUB_DOTCOM_API_BASE;
    const fetchFn = proxyFetchForHost(proxy, hostOf(ghBase));
    return new GitHubAdapter({ baseUrl: ghBase, token, cloneProtocol: 'pat', fetch: fetchFn });
  }
  if (kind === 'gitlab') {
    // GitLab 草稿 base_url 可留空 → 默认官方 gitlab.com/api/v4
    const glBase = baseUrl.trim() || GITLAB_DOTCOM_API_BASE;
    const fetchFn = proxyFetchForHost(proxy, hostOf(glBase));
    return new GitLabAdapter({ baseUrl: glBase, token, cloneProtocol: 'pat', fetch: fetchFn });
  }
  const fetchFn = proxyFetchForHost(proxy, hostOf(baseUrl));
  return new BitbucketServerAdapter({ baseUrl, token, cloneProtocol: 'pat', fetch: fetchFn });
}

/**
 * 把 config.connections 映射成可用的 Adapter 列表。M1 只支持 bitbucket-server kind；
 * 未来扩 GitHub / GitLab 时在 switch 里加 case 即可。
 * proxy 透传到每个 adapter 的 REST fetch。
 */
export function buildAdapters(
  connections: readonly Connection[],
  proxy: ProxyConfig,
): BuiltAdapter[] {
  return connections.map((conn) => ({
    connectionId: conn.id,
    adapter: buildOne(conn, proxy),
  }));
}

function buildOne(conn: Connection, proxy: ProxyConfig): PlatformAdapter {
  // 开关开 + 目标非 loopback → 带 ProxyAgent 的 fetch；否则 undefined（默认直连）。
  const fetchFn = proxyFetchForHost(proxy, hostOf(conn.base_url));
  switch (conn.kind) {
    case 'bitbucket-server':
      return new BitbucketServerAdapter({
        baseUrl: conn.base_url,
        token: conn.auth.token,
        cloneProtocol: conn.clone.protocol,
        fetch: fetchFn,
      });
    case 'github':
      return new GitHubAdapter({
        baseUrl: conn.base_url,
        token: conn.auth.token,
        cloneProtocol: conn.clone.protocol,
        fetch: fetchFn,
      });
    case 'gitlab':
      return new GitLabAdapter({
        baseUrl: conn.base_url,
        token: conn.auth.token,
        cloneProtocol: conn.clone.protocol,
        fetch: fetchFn,
      });
    default: {
      const exhaustive: never = conn;
      throw new Error(`unsupported connection kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
