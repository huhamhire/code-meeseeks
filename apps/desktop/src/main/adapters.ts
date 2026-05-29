import { BitbucketServerAdapter } from '@pr-pilot/platform-bitbucket-server';
import type { Connection, PlatformAdapter } from '@pr-pilot/shared';

export interface BuiltAdapter {
  connectionId: string;
  adapter: PlatformAdapter;
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
      });
    default: {
      const exhaustive: never = conn.kind;
      throw new Error(`unsupported connection kind: ${String(exhaustive)}`);
    }
  }
}
