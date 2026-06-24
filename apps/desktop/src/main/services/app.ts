import { app } from 'electron';
import type { BootstrapResult } from '@meebox/config';
import type { ConnectionSummary } from '@meebox/ipc';
import type { AppInfo } from '@meebox/shared';
import type { BuiltAdapter } from '../adapters.js';

/** 应用 / 运行时版本信息（app:info）。纯数据组装，不依赖 controller 上下文。 */
export function buildAppInfo(bootstrap: BootstrapResult): AppInfo {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    nodeVersion: process.versions.node,
    platform: process.platform,
    firstRun: bootstrap.firstRun,
  };
}

/** 当前活动连接的状态摘要（app:connections）。 */
export function buildConnectionSummaries(
  bootstrap: BootstrapResult,
  adapters: readonly BuiltAdapter[],
): ConnectionSummary[] {
  // 单活动连接模型：状态栏只展示当前活动连接的启用状态（与 poller 只轮询活动连接一致）。
  const activeId = bootstrap.config.active_connection_id;
  return adapters
    .filter(({ connectionId }) => connectionId === activeId)
    .map(({ connectionId, adapter }) => {
      const conn = bootstrap.config.connections.find((c) => c.id === connectionId);
      return {
        connectionId,
        displayName: conn?.display_name ?? connectionId,
        user: adapter.connection.getCurrentUser(),
        capabilities: adapter.connection.capabilities(),
      };
    });
}
