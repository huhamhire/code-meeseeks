import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { BootstrapResult } from '@meebox/config';
import type { ConnectionSummary, IpcChannels } from '@meebox/ipc';
import type { AppInfo } from '@meebox/shared';
import type { BuiltAdapter } from '../../adapters.js';
import { t } from '../../i18n/index.js';
import { sniffImageContentType } from '../../utils/image.js';
import { checkForUpdate } from '../../utils/update-check.js';
import { getLastUpdateResult, publishUpdateResult } from '../../utils/update-state.js';
import type { IpcContext } from '../context.js';

/** GUI 框架交互域：应用信息 / 框架窗口 / 外部打开 / 对话框 / 日志回传 / 连接与头像。 */
export function registerAppHandlers(ctx: IpcContext): void {
  const { bootstrap, logger, getPrAgentStatus, connectionRuntime, effectiveAgentDir } = ctx;

  ipcMain.handle('app:info', (): IpcChannels['app:info']['response'] => buildAppInfo(bootstrap));
  ipcMain.handle('app:paths', (): IpcChannels['app:paths']['response'] => bootstrap.paths);
  ipcMain.handle(
    'app:prAgentStatus',
    (): Promise<IpcChannels['app:prAgentStatus']['response']> => getPrAgentStatus(),
  );

  // 渲染层日志回传：落进同一份 meebox.log（scope=renderer），与 main 日志合流便于排查。
  const rendererLogger = logger.child({ scope: 'renderer' });
  ipcMain.handle('log:write', (_evt, req: IpcChannels['log:write']['request']): void => {
    const obj = req.meta ?? {};
    switch (req.level) {
      case 'error':
        rendererLogger.error(obj, req.msg);
        break;
      case 'warn':
        rendererLogger.warn(obj, req.msg);
        break;
      case 'info':
        rendererLogger.info(obj, req.msg);
        break;
      case 'debug':
        rendererLogger.debug(obj, req.msg);
        break;
    }
  });

  ipcMain.handle('app:connections', (): IpcChannels['app:connections']['response'] =>
    buildConnectionSummaries(bootstrap, connectionRuntime.adapters),
  );

  // (connectionId, slug) → dataUrl 或 null。两级 cache：
  //   1) avatarMem: 进程内 Map，本会话内瞬时返回（含 null 负缓存避免重试失败 slug）
  //   2) 磁盘文件 <cacheDir>/avatars/<hash>.bin，TTL 7 天，按 mtime 判定过期
  //      过期或不存在 → 重新打 Bitbucket → 写回磁盘
  // hash = sha256(connectionId|slug) 前 24 hex，纯字母数字文件名安全
  const AVATAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const avatarDir = path.join(bootstrap.paths.cacheDir, 'avatars');
  const avatarMem = new Map<string, { dataUrl: string } | null>();

  ipcMain.handle(
    'app:userAvatar',
    async (
      _evt,
      req: IpcChannels['app:userAvatar']['request'],
    ): Promise<IpcChannels['app:userAvatar']['response']> => {
      const memKey = `${req.connectionId}|${req.slug}`;
      if (avatarMem.has(memKey)) return avatarMem.get(memKey)!;

      const hash = crypto.createHash('sha256').update(memKey).digest('hex').slice(0, 24);
      const filePath = path.join(avatarDir, `${hash}.bin`);

      // 1) 磁盘 cache 命中且未过期？命中不打日志 (高频路径，避免日志噪音)
      try {
        const stat = await fs.stat(filePath);
        const age = Date.now() - stat.mtimeMs;
        if (age < AVATAR_TTL_MS) {
          const bytes = await fs.readFile(filePath);
          const contentType = sniffImageContentType(bytes);
          const result = {
            dataUrl: `data:${contentType};base64,${bytes.toString('base64')}`,
          };
          avatarMem.set(memKey, result);
          return result;
        }
        // 过期：删了重拉。删失败也没关系（writeFile 会覆盖）
        await fs.unlink(filePath).catch(() => undefined);
      } catch {
        // 文件不存在 / 读失败 → 走 fetch
      }

      // 2) 没缓存 / 已过期：去 Bitbucket 拉
      const adapter = connectionRuntime.adapters.find(
        (a) => a.connectionId === req.connectionId,
      )?.adapter;
      if (!adapter) {
        avatarMem.set(memKey, null);
        return null;
      }
      try {
        const img = await adapter.getUserAvatar(req.slug, req.avatarUrl);
        if (!img) {
          logger.debug(
            { connectionId: req.connectionId, slug: req.slug },
            'avatar fetch returned null',
          );
          avatarMem.set(memKey, null);
          return null;
        }
        // 落盘：best-effort，写失败不影响响应
        try {
          await fs.mkdir(avatarDir, { recursive: true });
          await fs.writeFile(filePath, img.bytes);
        } catch (writeErr) {
          logger.warn({ err: writeErr, hash }, 'avatar disk write failed');
        }
        const base64 = Buffer.from(img.bytes).toString('base64');
        const result = { dataUrl: `data:${img.contentType};base64,${base64}` };
        avatarMem.set(memKey, result);
        logger.debug(
          {
            hash,
            slug: req.slug,
            bytes: img.bytes.length,
            contentType: img.contentType,
          },
          'avatar fetched + cached to disk',
        );
        return result;
      } catch (err) {
        logger.warn({ err, connectionId: req.connectionId, slug: req.slug }, 'avatar fetch threw');
        avatarMem.set(memKey, null);
        return null;
      }
    },
  );

  ipcMain.handle('app:openConfigFile', async (): Promise<void> => {
    const err = await shell.openPath(bootstrap.paths.configFile);
    if (err) throw new Error(`failed to open config.yaml: ${err}`);
  });
  ipcMain.handle('app:openAgentDir', async (): Promise<void> => {
    // 当前生效的 Agent 目录（用户配置优先，否则默认 ~/.code-meeseeks/agent）；先确保存在再打开。
    const dir = effectiveAgentDir();
    await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
    const err = await shell.openPath(dir);
    if (err) throw new Error(`failed to open agent dir: ${err}`);
  });
  ipcMain.handle('app:openDevTools', (evt) => {
    evt.sender.openDevTools({ mode: 'detach' });
  });
  ipcMain.handle(
    'app:checkUpdate',
    async (): Promise<IpcChannels['app:checkUpdate']['response']> => {
      // 与启动检测一致受 check_enabled 控制：关闭时不发起请求，直接返回禁用结果。
      if (!bootstrap.config.update.check_enabled) {
        return {
          ok: false,
          hasUpdate: false,
          currentVersion: app.getVersion(),
          error: 'update check disabled by config',
        };
      }
      const result = await checkForUpdate(app.getVersion(), bootstrap.config.proxy);
      // 交给单一真相源：缓存 + 有新版则广播到所有窗口（状态栏据此同步，不再只回设置页本地）。
      publishUpdateResult(result);
      return result;
    },
  );
  ipcMain.handle(
    'app:getUpdateStatus',
    (): IpcChannels['app:getUpdateStatus']['response'] => getLastUpdateResult(),
  );
  ipcMain.handle(
    'app:openExternal',
    async (_evt, req: IpcChannels['app:openExternal']['request']): Promise<void> => {
      // 白名单：仅放行 http(s)，防止 file:// / javascript: 等被恶意 markdown 注入触发
      if (!/^https?:\/\//.test(req.url)) return;
      await shell.openExternal(req.url);
    },
  );

  ipcMain.handle(
    'dialog:pickDirectory',
    async (
      evt,
      req: IpcChannels['dialog:pickDirectory']['request'],
    ): Promise<IpcChannels['dialog:pickDirectory']['response']> => {
      const win = BrowserWindow.fromWebContents(evt.sender) ?? undefined;
      const result = win
        ? await dialog.showOpenDialog(win, {
            title: req.title ?? t('dialog.selectDirectory'),
            defaultPath: req.defaultPath,
            properties: ['openDirectory', 'createDirectory'],
          })
        : await dialog.showOpenDialog({
            title: req.title ?? t('dialog.selectDirectory'),
            defaultPath: req.defaultPath,
            properties: ['openDirectory', 'createDirectory'],
          });
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null };
      }
      return { path: result.filePaths[0]! };
    },
  );
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

function buildConnectionSummaries(
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
        user: adapter.getCurrentUser(),
        capabilities: adapter.capabilities(),
      };
    });
}
