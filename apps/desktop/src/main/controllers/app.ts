import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import type { Logger } from 'pino';
import { t } from '../i18n/index.js';
import { buildAppInfo, buildConnectionSummaries } from '../services/app.js';
import { sniffImageContentType } from '../utils/image.js';
import { checkForUpdate } from '../utils/update-check.js';
import { getLastUpdateResult, publishUpdateResult } from '../utils/update-state.js';
import type { IpcController } from './register.js';

// ── GUI 框架交互域 controllers：应用信息 / 框架窗口 / 外部打开 / 对话框 / 日志回传 / 连接与头像 ──

export const readAppInfo: IpcController<'app:info'> = (ctx) => buildAppInfo(ctx.bootstrap);

export const readAppPaths: IpcController<'app:paths'> = (ctx) => ctx.bootstrap.paths;

export const readPrAgentStatus: IpcController<'app:prAgentStatus'> = (ctx) =>
  ctx.getPrAgentStatus();

// 渲染层错误 / 未捕获异常转发到 main，按级别写 renderer scope 日志（落同一份 meebox.log）。
let rendererLogger: Logger | undefined;
export const writeRendererLog: IpcController<'log:write'> = (ctx, req) => {
  rendererLogger ??= ctx.logger.child({ scope: 'renderer' });
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
};

// 各连接 ping 后缓存（当前用户 + display_name），Header / 状态栏用。
export const listConnections: IpcController<'app:connections'> = (ctx) =>
  buildConnectionSummaries(ctx.bootstrap, ctx.connectionRuntime.adapters);

// 头像两级缓存：进程内 Map（含 null 负缓存）+ 磁盘文件（TTL 7 天，按 mtime 判过期）。
const AVATAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const avatarMem = new Map<string, { dataUrl: string } | null>();

// 按 (connectionId, slug) 拉头像 dataUrl：内存 → 磁盘 → 远端，失败回 null。
export const getUserAvatar: IpcController<'app:userAvatar'> = async (ctx, req) => {
  const { logger, connectionRuntime, bootstrap } = ctx;
  const avatarDir = path.join(bootstrap.paths.cacheDir, 'avatars');
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
      const result = { dataUrl: `data:${contentType};base64,${bytes.toString('base64')}` };
      avatarMem.set(memKey, result);
      return result;
    }
    // 过期：删了重拉。删失败也没关系（writeFile 会覆盖）
    await fs.unlink(filePath).catch(() => undefined);
  } catch {
    // 文件不存在 / 读失败 → 走 fetch
  }

  // 2) 没缓存 / 已过期：去远端拉
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
      logger.debug({ connectionId: req.connectionId, slug: req.slug }, 'avatar fetch returned null');
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
      { hash, slug: req.slug, bytes: img.bytes.length, contentType: img.contentType },
      'avatar fetched + cached to disk',
    );
    return result;
  } catch (err) {
    logger.warn({ err, connectionId: req.connectionId, slug: req.slug }, 'avatar fetch threw');
    avatarMem.set(memKey, null);
    return null;
  }
};

// OS 默认编辑器打开 config.yaml。
export const openConfigFile: IpcController<'app:openConfigFile'> = async (ctx) => {
  const err = await shell.openPath(ctx.bootstrap.paths.configFile);
  if (err) throw new Error(`failed to open config.yaml: ${err}`);
};

// 文件管理器打开当前生效的 Agent 目录（不存在则先建）。
export const openAgentDir: IpcController<'app:openAgentDir'> = async (ctx) => {
  const dir = ctx.effectiveAgentDir();
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
  const err = await shell.openPath(dir);
  if (err) throw new Error(`failed to open agent dir: ${err}`);
};

// 打开 DevTools（分离窗口）——需访问发起调用的 webContents。
export const openDevTools: IpcController<'app:openDevTools'> = (_ctx, _req, evt) => {
  evt.sender.openDevTools({ mode: 'detach' });
};

// 手动检测更新：受 check_enabled 门控；结果交单一真相源缓存 + 有新版广播。
export const checkUpdate: IpcController<'app:checkUpdate'> = async (ctx) => {
  if (!ctx.bootstrap.config.update.check_enabled) {
    return {
      ok: false,
      hasUpdate: false,
      currentVersion: app.getVersion(),
      error: 'update check disabled by config',
    };
  }
  const result = await checkForUpdate(app.getVersion(), ctx.bootstrap.config.proxy);
  publishUpdateResult(result);
  return result;
};

// 读 main 缓存的最近一次更新检测结果（不发请求）。
export const getUpdateStatus: IpcController<'app:getUpdateStatus'> = () => getLastUpdateResult();

// 系统浏览器打开外链（白名单仅放行 http(s)，防 file:// / javascript: 注入）。
export const openExternal: IpcController<'app:openExternal'> = async (_ctx, req) => {
  if (!/^https?:\/\//.test(req.url)) return;
  await shell.openExternal(req.url);
};

// 系统原生目录选择对话框——需绑定到发起调用的窗口。
export const pickDirectory: IpcController<'dialog:pickDirectory'> = async (_ctx, req, evt) => {
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
};
