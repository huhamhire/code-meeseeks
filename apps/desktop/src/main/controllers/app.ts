import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import type { Logger } from 'pino';
import { setWindowControlColors as applyWindowControlColors } from '../bootstrap/window-manager.js';
import { buildAppInfo, buildConnectionSummaries } from '../services/app.js';
import { getContext } from '../services/context.js';
import { applyBadgeCount } from '../services/notifications.js';
import { sniffImageContentType } from '../utils/image.js';
import { checkForUpdate } from '../utils/update-check.js';
import { getLastUpdateResult, publishUpdateResult } from '../utils/update-state.js';
import type { IpcController } from './types.js';

/*
 * GUI shell interaction-domain controllers: app info / shell window / external open / dialogs / log relay / connections and avatars
 */

/**
 * App / runtime version info (About page).
 */
export const readAppInfo: IpcController<'app:info'> = () => buildAppInfo(getContext().bootstrap);

/**
 * Key directory paths (config / agent / logs).
 */
export const readAppPaths: IpcController<'app:paths'> = () => getContext().bootstrap.paths;

/**
 * The renderer pushes window-control button colors after applying a theme (follows the specific theme's --bg-app/--text-primary); null falls back to generic dark/light.
 */
export const setWindowControlColors: IpcController<'window:setControlColors'> = (_event, req) => {
  applyWindowControlColors(req);
};

/**
 * pr-agent probe status (whether it is ready).
 */
export const readPrAgentStatus: IpcController<'app:prAgentStatus'> = () =>
  getContext().getPrAgentStatus();

let rendererLogger: Logger | undefined;
/**
 * Renderer errors / uncaught exceptions are forwarded to main and written to the renderer-scope log by level (into the same meebox.log).
 */
export const writeRendererLog: IpcController<'log:write'> = (_event, req) => {
  rendererLogger ??= getContext().logger.child({ scope: 'renderer' });
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

/**
 * Per-connection post-ping cache (current user + display_name), used by the Header / status bar.
 */
export const listConnections: IpcController<'app:connections'> = () => {
  const { bootstrap, connectionRuntime } = getContext();
  return buildConnectionSummaries(bootstrap, connectionRuntime.adapters);
};

// Two-level avatar cache: in-process Map (including null negative cache) + disk file (TTL 7 days, expiry judged by mtime).
const AVATAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const avatarMem = new Map<string, { dataUrl: string } | null>();

/**
 * Fetch the avatar dataUrl by (connectionId, slug): memory → disk → remote, returning null on failure.
 */
export const getUserAvatar: IpcController<'app:userAvatar'> = async (_event, req) => {
  const { logger, connectionRuntime, bootstrap } = getContext();
  const avatarDir = path.join(bootstrap.paths.cacheDir, 'avatars');
  const memKey = `${req.connectionId}|${req.slug}`;
  if (avatarMem.has(memKey)) return avatarMem.get(memKey)!;

  const hash = crypto.createHash('sha256').update(memKey).digest('hex').slice(0, 24);
  const filePath = path.join(avatarDir, `${hash}.bin`);

  // 1) Disk cache hit and not expired? Do not log on hit (high-frequency path, avoid log noise)
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
    // Expired: delete and re-fetch. A failed delete is fine (writeFile will overwrite)
    await fs.unlink(filePath).catch(() => undefined);
  } catch {
    // File missing / read failed → go to fetch
  }

  // 2) No cache / expired: fetch from remote
  const adapter = connectionRuntime.adapters.find(
    (a) => a.connectionId === req.connectionId,
  )?.adapter;
  if (!adapter) {
    avatarMem.set(memKey, null);
    return null;
  }
  try {
    const img = await adapter.media.getUserAvatar(req.slug, req.avatarUrl);
    if (!img) {
      logger.debug(
        { connectionId: req.connectionId, slug: req.slug },
        'avatar fetch returned null',
      );
      avatarMem.set(memKey, null);
      return null;
    }
    // Persist to disk: best-effort, a write failure does not affect the response
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

/**
 * Open config.yaml in the OS default editor.
 */
export const openConfigFile: IpcController<'app:openConfigFile'> = async () => {
  const err = await shell.openPath(getContext().bootstrap.paths.configFile);
  if (err) throw new Error(`failed to open config.yaml: ${err}`);
};

/**
 * Open the currently effective Agent directory in the file manager. First lazily fill in the context templates (ensureAgentDir is idempotent and creates the directory),
 * so opening it directly (when no review has ever run) still shows SOUL/AGENTS and other files rather than an empty directory.
 */
export const openAgentDir: IpcController<'app:openAgentDir'> = async () => {
  const dir = await getContext().ensureAgentDir();
  const err = await shell.openPath(dir);
  if (err) throw new Error(`failed to open agent dir: ${err}`);
};

/**
 * Open DevTools (detached window) — needs access to the calling webContents.
 */
export const openDevTools: IpcController<'app:openDevTools'> = (event) => {
  event.sender.openDevTools({ mode: 'detach' });
};

/**
 * Set the app badge count (currently macOS dock only). The renderer already derives the "awaiting response" count from the PR list + notification config; the main process only applies it.
 */
export const setBadgeCount: IpcController<'app:setBadgeCount'> = (_event, req) => {
  applyBadgeCount(req.count);
};

/**
 * Manual update check: gated by check_enabled; the result is handed to the single-source-of-truth cache + broadcast when a new version exists.
 */
export const checkUpdate: IpcController<'app:checkUpdate'> = async () => {
  const { bootstrap } = getContext();
  if (!bootstrap.config.update.check_enabled) {
    return {
      ok: false,
      hasUpdate: false,
      currentVersion: app.getVersion(),
      error: 'update check disabled by config',
    };
  }
  const result = await checkForUpdate(app.getVersion(), bootstrap.config.proxy);
  publishUpdateResult(result);
  return result;
};

/**
 * Read the main-cached most recent update-check result (issues no request).
 */
export const getUpdateStatus: IpcController<'app:getUpdateStatus'> = () => getLastUpdateResult();

/**
 * Open an external link in the system browser (allowlist permits only http(s), guarding against file:// / javascript: injection).
 */
export const openExternal: IpcController<'app:openExternal'> = async (_event, req) => {
  if (!/^https?:\/\//.test(req.url)) return;
  await shell.openExternal(req.url);
};

/**
 * Open the macOS "System Settings → Notifications" panel to guide the user to grant / enable notification permission (macOS manages notification authorization at the system level; the app cannot
 * enable it on the user's behalf). No-op on non-macOS. The notifications panel's pane id varies by system version (renamed in Ventura+), so fall back one by one; if all fail,
 * fall back to the System Settings root.
 */
export const openNotificationSettings: IpcController<
  'app:openNotificationSettings'
> = async () => {
  if (process.platform !== 'darwin') return;
  const panes = [
    'x-apple.systempreferences:com.apple.Notifications-Settings.extension', // Ventura(13)+
    'x-apple.systempreferences:com.apple.preference.notifications', // older versions
    'x-apple.systempreferences:', // fallback: System Settings root
  ];
  for (const url of panes) {
    try {
      await shell.openExternal(url);
      return;
    } catch {
      // This pane id is not recognized on the current system version → try the next one
    }
  }
};

/**
 * Native OS directory-picker dialog — must be bound to the calling window.
 */
export const pickDirectory: IpcController<'dialog:pickDirectory'> = async (event, req) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  // The title is provided by the frontend per UI language (directory picking is interaction-domain text, maintained uniformly by renderer i18n; the main process no longer localizes it).
  const result = win
    ? await dialog.showOpenDialog(win, {
        title: req.title,
        defaultPath: req.defaultPath,
        properties: ['openDirectory', 'createDirectory'],
      })
    : await dialog.showOpenDialog({
        title: req.title,
        defaultPath: req.defaultPath,
        properties: ['openDirectory', 'createDirectory'],
      });
  if (result.canceled || result.filePaths.length === 0) {
    return { path: null };
  }
  return { path: result.filePaths[0]! };
};
