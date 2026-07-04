import { BitbucketServerAdapter } from '@meebox/platform-bitbucket-server';
import { GitHubAdapter } from '@meebox/platform-github';
import { GitLabAdapter } from '@meebox/platform-gitlab';
import {
  GITHUB_DOTCOM_API_BASE,
  GITLAB_DOTCOM_API_BASE,
  type Connection,
  type PlatformKind,
  type ProxyConfig,
} from '@meebox/shared';
import type { PlatformAdapter } from '@meebox/platform-core';
import { proxyFetchForHost } from './utils/proxy.js';

export interface BuiltAdapter {
  connectionId: string;
  adapter: PlatformAdapter;
}

/**
 * Mutable connections runtime holding: adapters (full set, IPC looks up any connection by id) +
 * adapterByHost (repo-mirror finds an adapter by host to get its clone url). When the settings page
 * changes connections, reconfigure replaces the contents in place; IPC handler / repoMirror read the
 * new values through the reference, no restart needed.
 */
export interface ConnectionRuntime {
  adapters: BuiltAdapter[];
  adapterByHost: Map<string, PlatformAdapter>;
}

/**
 * Spin up a temporary adapter from a draft base_url + token, only for the settings page ping test.
 * kind defaults to bitbucket-server (backward compatible with old calls). proxy is unified into the
 * connection layer: pass the proxy config and factory through to the adapter, and the connection layer
 * resolves once by the baseUrl host (REST goes through the proxy when the switch is on and the target
 * is non-loopback).
 */
export function buildDraftAdapter(
  baseUrl: string,
  token: string,
  proxy: ProxyConfig,
  kind: PlatformKind = 'bitbucket-server',
): PlatformAdapter {
  if (kind === 'github') {
    // GitHub draft base_url can be left empty → defaults to the official api.github.com
    const ghBase = baseUrl.trim() || GITHUB_DOTCOM_API_BASE;
    return new GitHubAdapter({
      baseUrl: ghBase,
      token,
      cloneProtocol: 'pat',
      proxy,
      proxyFetch: proxyFetchForHost,
    });
  }
  if (kind === 'gitlab') {
    // GitLab draft base_url can be left empty → defaults to the official gitlab.com/api/v4
    const glBase = baseUrl.trim() || GITLAB_DOTCOM_API_BASE;
    return new GitLabAdapter({
      baseUrl: glBase,
      token,
      cloneProtocol: 'pat',
      proxy,
      proxyFetch: proxyFetchForHost,
    });
  }
  return new BitbucketServerAdapter({
    baseUrl,
    token,
    cloneProtocol: 'pat',
    proxy,
    proxyFetch: proxyFetchForHost,
  });
}

/**
 * Map config.connections into a list of usable Adapters. M1 only supports the bitbucket-server kind;
 * to extend to GitHub / GitLab later, just add a case in the switch.
 * proxy is passed through to each adapter's REST fetch.
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
  // proxy is unified into the connection layer: pass the proxy config and factory through, and the
  // connection layer resolves by the baseUrl host (switch on + target non-loopback → fetch with a
  // ProxyAgent; otherwise direct).
  const common = {
    baseUrl: conn.base_url,
    token: conn.auth.token,
    cloneProtocol: conn.clone.protocol,
    proxy,
    proxyFetch: proxyFetchForHost,
  };
  switch (conn.kind) {
    case 'bitbucket-server':
      return new BitbucketServerAdapter(common);
    case 'github':
      return new GitHubAdapter(common);
    case 'gitlab':
      return new GitLabAdapter(common);
    default: {
      const exhaustive: never = conn;
      throw new Error(`unsupported connection kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
