import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonFileStateStore } from '@meebox/state-store';
import type { Logger } from 'pino';
import { readWindowState, writeWindowState, type WindowState } from './utils/window-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface WindowManager {
  /** 创建主窗口（首个传 splash，主界面首帧就绪时关闭它；macOS activate 再建时不传）。 */
  create(splash?: BrowserWindow): void;
}

/**
 * 主窗口管理：载入窗口状态（尺寸 / 最大化）、建窗（恢复尺寸 + 自绘标题栏 + 外链路由 + 首帧显示/关 splash）、
 * resize/move/close 防抖回写。windowState 在管理器内持有，跨多次 create（如 macOS activate 重建）保持最新。
 */
export async function createWindowManager(deps: {
  stateStore: JsonFileStateStore;
  logger: Logger;
  /** 进程启动时刻，用于度量到首帧（ready-to-show）的启动耗时。 */
  startMs: number;
}): Promise<WindowManager> {
  const { stateStore, logger, startMs } = deps;
  // 载入窗口状态（尺寸/最大化）。缺失或损坏 → 空对象，建窗回退默认尺寸。
  let windowState: WindowState = await readWindowState(stateStore).catch((err: unknown) => {
    logger.warn({ err }, 'read window state failed; use default window size');
    return {};
  });

  const create = (splash?: BrowserWindow): void => {
    // 最小尺寸保证核心三栏（sidebar 240 + file-tree 180 + diff 内容）在 chat-pane 折叠态下仍可用；
    // 高度兜住 pr-header + tabs + diff + statusbar。尺寸优先用本地记录，无记录回退默认 1280×800。
    const win = new BrowserWindow({
      width: windowState.width ?? 1280,
      height: windowState.height ?? 800,
      minWidth: 960,
      minHeight: 600,
      show: false,
      // 首帧前的窗口底色与 app 一致，避免显示瞬间白闪
      backgroundColor: '#1e1e1e',
      // 无边框 + 自绘标题栏（VS Code 风）：macOS 保留红绿灯并下移到自绘标题栏内；Windows/Linux 用
      // titleBarOverlay 让系统继续画窗控按钮，渲染层只接管中间标题区。高度需与 .app-titlebar 一致（36px）。
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 12, y: 11 } }
        : { titleBarOverlay: { color: '#1e1e1e', symbolColor: '#cccccc', height: 36 } }),
      // dev 下显式给窗口图标；打包态窗口/任务栏图标走 exe 内嵌（electron-builder），故仅 dev 设置。
      icon: app.isPackaged
        ? undefined
        : path.join(app.getAppPath(), '../../assets/icons/icon.ico'),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    // 记住窗口大小：resize/move 防抖回写、关闭时立即回写。getNormalBounds 取「非最大化」尺寸，
    // 故最大化时记录的仍是还原后的正常大小。写盘失败不影响使用。
    const persistWindowState = (): void => {
      if (win.isDestroyed()) return;
      const b = win.getNormalBounds();
      windowState = { width: b.width, height: b.height, maximized: win.isMaximized() };
      void writeWindowState(stateStore, windowState).catch((err: unknown) => {
        logger.warn({ err }, 'persist window state failed');
      });
    };
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleSave = (): void => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(persistWindowState, 400);
    };
    win.on('resize', scheduleSave);
    win.on('move', scheduleSave);
    win.on('close', persistWindowState);

    // 主界面首帧就绪：恢复最大化态 → 显示主窗口 → 关闭 splash，并记录进程启动→首帧耗时。
    // maximize 必须放到这里：建窗后即调用会让无边框窗口在内容就绪前以空白态抢先出现（盖过/早于 splash）。
    win.once('ready-to-show', () => {
      if (windowState.maximized) win.maximize();
      win.show();
      if (splash && !splash.isDestroyed()) splash.close();
      logger.info({ elapsedMs: Date.now() - startMs }, 'main window first paint (ready-to-show)');
    });

    // 把 <a target="_blank"> / window.open 都路由到 OS 默认浏览器，不在 Electron 内开新窗口。
    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });

    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      void win.loadFile(path.join(__dirname, '../renderer/index.html'));
    }
  };

  return { create };
}
