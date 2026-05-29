import { app, ipcMain } from 'electron';
import type { Logger } from 'pino';
import type { BootstrapResult } from '@pr-pilot/config';
import { Poller, listStoredPullRequests, setLocalStatus } from '@pr-pilot/poller';
import type { AppInfo, IpcChannels, PrAgentStatus } from '@pr-pilot/shared';
import type { JsonFileStateStore } from '@pr-pilot/state-store';

interface RegisterDeps {
  bootstrap: BootstrapResult;
  logger: Logger;
  prAgentStatus: PrAgentStatus;
  stateStore: JsonFileStateStore;
  poller: Poller;
}

/**
 * 注册全部 IPC handler。后续新增 channel 时只需扩 IpcChannels + 在此添加一个 handle。
 * 故意保持显式，每个 channel 一行映射，方便审计 main↔renderer 暴露面。
 */
export function registerIpcHandlers({
  bootstrap,
  logger,
  prAgentStatus,
  stateStore,
  poller,
}: RegisterDeps): void {
  ipcMain.handle('app:info', (): IpcChannels['app:info']['response'] => buildAppInfo(bootstrap));
  ipcMain.handle('app:paths', (): IpcChannels['app:paths']['response'] => bootstrap.paths);
  ipcMain.handle(
    'app:prAgentStatus',
    (): IpcChannels['app:prAgentStatus']['response'] => prAgentStatus,
  );
  ipcMain.handle('config:read', (): IpcChannels['config:read']['response'] => bootstrap.config);

  ipcMain.handle(
    'prs:list',
    async (): Promise<IpcChannels['prs:list']['response']> => listStoredPullRequests(stateStore),
  );
  ipcMain.handle(
    'prs:refresh',
    async (): Promise<IpcChannels['prs:refresh']['response']> => poller.tick(),
  );
  ipcMain.handle(
    'prs:setLocalStatus',
    async (
      _evt,
      req: IpcChannels['prs:setLocalStatus']['request'],
    ): Promise<IpcChannels['prs:setLocalStatus']['response']> =>
      setLocalStatus(stateStore, req.localId, req.status),
  );

  logger.debug('IPC handlers registered');
}

function buildAppInfo(bootstrap: BootstrapResult): AppInfo {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    nodeVersion: process.versions.node,
    platform: process.platform,
    firstRun: bootstrap.firstRun,
  };
}
