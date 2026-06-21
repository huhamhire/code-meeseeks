import type { BootstrapResult } from '@meebox/config';
import type { Poller } from '@meebox/poller';
import type { PlatformAdapter, PlatformUser } from '@meebox/shared';
import type { JsonFileStateStore } from '@meebox/state-store';
import type { Logger } from 'pino';
import { buildAdapters, type ConnectionRuntime } from './adapters.js';
import { writeConnectionStates, type ConnectionState } from './utils/connection-state.js';

/**
 * 连接运行时控制器：把启动序列里的「连接接线 / ping / 热重配」从 index.ts 抽出收口。
 * 「接线」与「ping」解耦，实现「启动不依赖网络」——见各方法注释。
 */
export interface ConnectionRuntimeController {
  /** 可变持有的连接运行时（adapters 全量 + adapterByHost）；IPC / repoMirror 经引用读到最新值。 */
  readonly runtime: ConnectionRuntime;
  /** 重建 adapters/byHost、用本地持久化身份预热 currentUser、把活动连接喂给 poller（同步、无网络，可在建窗前调）。 */
  wire(): void;
  /** 全异步 ping：刷新远端身份并增量持久化；活动连接身份变化（含首次取得）则补一轮 poll（有网络，不在启动关键路径）。 */
  ping(): void;
  /** 设置页改连接 / 代理后的热生效：重接线 + 归档非活动连接（本地 IO）+ 异步 ping。 */
  reconfigure(): Promise<void>;
  /** 当前启用连接的 id 列表（poller.archiveConnectionsExcept 用）。 */
  activeConnectionIds(): string[];
}

export function createConnectionRuntime(deps: {
  bootstrap: BootstrapResult;
  stateStore: JsonFileStateStore;
  poller: Poller;
  logger: Logger;
  /** 启动时载入的连接级本地状态（含上次 ping 的 currentUser）；内部随 ping 增量回写。 */
  initialStates: Record<string, ConnectionState>;
}): ConnectionRuntimeController {
  const { bootstrap, stateStore, poller, logger } = deps;
  let connectionStates = deps.initialStates;
  const runtime: ConnectionRuntime = { adapters: [], adapterByHost: new Map() };

  const activeConnectionIds = (): string[] =>
    runtime.adapters
      .filter((a) => a.connectionId === bootstrap.config.active_connection_id)
      .map((a) => a.connectionId);

  const wire = (): void => {
    const adapters = buildAdapters(bootstrap.config.connections, bootstrap.config.proxy);
    const byHost = new Map<string, PlatformAdapter>();
    for (const { connectionId, adapter } of adapters) {
      // 预热 currentUser：有本地记录就先填上（无记录则保持 null，由 ping 兜底）。
      const cachedUser = connectionStates[connectionId]?.user;
      if (cachedUser) adapter.setCurrentUser?.(cachedUser);
      const conn = bootstrap.config.connections.find((c) => c.id === connectionId);
      if (!conn) continue;
      try {
        byHost.set(new URL(conn.base_url).hostname, adapter);
      } catch (err) {
        logger.warn({ err, connectionId, base_url: conn.base_url }, 'invalid base_url');
      }
    }
    runtime.adapters = adapters;
    runtime.adapterByHost = byHost;
    // 只轮询当前启用的连接（同时仅一条）；其余仅保留配置不轮询。
    poller.setConnections(
      adapters.filter((a) => a.connectionId === bootstrap.config.active_connection_id),
    );
  };

  // 持久化某连接的 currentUser（仅身份变化时写盘，避免无谓 IO）。写盘失败不影响运行。
  const persistConnectionUser = async (
    connectionId: string,
    user: PlatformUser | null,
  ): Promise<void> => {
    const prevName = connectionStates[connectionId]?.user?.name ?? null;
    if (prevName === (user?.name ?? null)) return;
    connectionStates = {
      ...connectionStates,
      [connectionId]: { ...connectionStates[connectionId], user },
    };
    try {
      await writeConnectionStates(stateStore, connectionStates);
    } catch (err) {
      logger.warn({ err, connectionId }, 'persist connection user failed');
    }
  };

  const ping = (): void => {
    const activeId = bootstrap.config.active_connection_id;
    for (const { connectionId, adapter } of runtime.adapters) {
      const isActive = connectionId === activeId;
      const beforeName = adapter.getCurrentUser()?.name ?? null;
      // 活动连接启动时无缓存身份 → poller.start(immediate=false) 没跑首轮；此处 ping settle 后必须触发
      // **首次同步**（无论 ping 成功与否）：「先确认身份，再立即同步一次」。
      const hadIdentity = beforeName !== null;
      void adapter.ping().then(
        async (r) => {
          logger.info(
            { connectionId, ok: r.ok, serverVersion: r.serverVersion, user: r.user?.name },
            'adapter ping',
          );
          const user = adapter.getCurrentUser();
          await persistConnectionUser(connectionId, user);
          // 触发重分类/首次同步：活动连接且（身份变化 含首次取得/换号，或本就无身份需补首轮）。
          if (isActive && (!hadIdentity || (user?.name ?? null) !== beforeName)) {
            void poller.tick();
          }
        },
        (err: unknown) => {
          logger.warn({ err, connectionId }, 'adapter ping failed');
          // ping 失败但活动连接本就无缓存身份（首轮被跳过）→ 仍用 PAT 兜底同步一次，避免看似没同步。
          if (isActive && !hadIdentity) void poller.tick();
        },
      );
    }
  };

  const reconfigure = async (): Promise<void> => {
    wire();
    await poller.archiveConnectionsExcept(activeConnectionIds());
    ping();
  };

  return { runtime, wire, ping, reconfigure, activeConnectionIds };
}
