import { BitbucketServerAdapter } from '@meebox/platform-bitbucket-server';
import type { Connection, PlatformAdapter } from '@meebox/shared';

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

/** 用草稿 base_url + token 临时起一个 bitbucket-server adapter，仅供设置页 ping 测试用。 */
export function buildDraftAdapter(baseUrl: string, token: string): PlatformAdapter {
  return new BitbucketServerAdapter({ baseUrl, token, cloneProtocol: 'pat' });
}

/**
 * 把 config.connections 映射成可用的 Adapter 列表。M1 只支持 bitbucket-server kind；
 * 未来扩 GitHub / GitLab / Gitea 时在 switch 里加 case 即可。
 */
export function buildAdapters(connections: readonly Connection[]): BuiltAdapter[] {
  return connections.map((conn) => ({
    connectionId: conn.id,
    adapter: buildOne(conn),
  }));
}

function buildOne(conn: Connection): PlatformAdapter {
  switch (conn.kind) {
    case 'bitbucket-server':
      return new BitbucketServerAdapter({
        baseUrl: conn.base_url,
        token: conn.auth.token,
        cloneProtocol: conn.clone.protocol,
      });
    default: {
      const exhaustive: never = conn.kind;
      throw new Error(`unsupported connection kind: ${String(exhaustive)}`);
    }
  }
}
