import { app } from 'electron';
import type { BootstrapResult } from '@meebox/config';
import type { ConnectionSummary } from '@meebox/ipc';
import type { AppInfo } from '@meebox/shared';
import type { BuiltAdapter } from '../adapters.js';

/** App / runtime version info (app:info). Pure data assembly, no controller context needed. */
export function buildAppInfo(bootstrap: BootstrapResult): AppInfo {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    nodeVersion: process.versions.node,
    platform: process.platform,
    osVersion: process.getSystemVersion(),
    arch: process.arch,
    firstRun: bootstrap.firstRun,
  };
}

/** Status summary of the currently active connection (app:connections). */
export function buildConnectionSummaries(
  bootstrap: BootstrapResult,
  adapters: readonly BuiltAdapter[],
): ConnectionSummary[] {
  // Single-active-connection model: the status bar only shows the enabled state of the current active connection (consistent with poller only polling the active connection).
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
