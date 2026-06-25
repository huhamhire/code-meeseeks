import { app, BrowserWindow, screen, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonFileStateStore } from '@meebox/state-store';
import type { Logger } from 'pino';
import {
  readWindowState,
  writeWindowState,
  writeWindowStateSync,
  type WindowState,
} from '../utils/window-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 默认窗口尺寸（无本地记录时）。最小尺寸保证核心三栏（sidebar 240 + file-tree 180 + diff 内容）在
// chat-pane 折叠态下仍可用；高度兜住 pr-header + tabs + diff + statusbar。单位均为 DIP（设备无关像素）。
const DEFAULT_SIZE = { width: 1280, height: 800 };
const MIN_SIZE = { width: 960, height: 600 };

/**
 * 解析建窗尺寸/位置：把期望尺寸（本地记录优先，回退默认）clamp 进**当前显示器工作区**，并据此压低最小
 * 尺寸——否则高 DPI 缩放后工作区（DIP）可能小于默认/最小值，窗口被撑大溢出屏幕（issue：缩放后默认尺寸超屏）。
 * 取光标所在显示器（多屏更贴合「在哪开窗」），按其工作区居中，保证整窗在屏内（不持久化 x/y，仅建窗定位）。
 */
function resolveWindowBounds(state: WindowState): {
  x: number;
  y: number;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
} {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const minWidth = Math.min(MIN_SIZE.width, area.width);
  const minHeight = Math.min(MIN_SIZE.height, area.height);
  const width = Math.min(Math.max(state.width ?? DEFAULT_SIZE.width, minWidth), area.width);
  const height = Math.min(Math.max(state.height ?? DEFAULT_SIZE.height, minHeight), area.height);
  const x = Math.round(area.x + (area.width - width) / 2);
  const y = Math.round(area.y + (area.height - height) / 2);
  return { x, y, width, height, minWidth, minHeight };
}

/**
 * 主窗口管理：建窗（恢复尺寸 + 自绘标题栏 + 外链路由 + 首帧显示/关 splash）+ resize/move/close 防抖回写。
 * windowState 是实例可变状态（跨多次 create——如 macOS activate 重建——保持最新），故以 class 封装；
 * 异步载入由 loadWindowManager 完成（构造同步、不持异步）。
 */
export class WindowManager {
  constructor(
    private readonly stateStore: JsonFileStateStore,
    /** state 目录绝对路径；关窗同步落盘兜底用（见 writeWindowStateSync）。 */
    private readonly stateDir: string,
    private readonly logger: Logger,
    /** 进程启动时刻，用于度量到首帧（ready-to-show）的启动耗时。 */
    private readonly startMs: number,
    /** 当前窗口状态（尺寸/最大化）；随 resize/maximize/close 回写。 */
    private windowState: WindowState,
  ) {}

  /** 创建主窗口（首个传 splash，主界面首帧就绪时关闭它；macOS activate 再建时不传）。 */
  create(splash?: BrowserWindow): void {
    // 尺寸/位置：本地记录优先、回退默认，并按当前显示器工作区 clamp + 居中（高 DPI 缩放下防溢出屏幕）。
    const bounds = resolveWindowBounds(this.windowState);
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      minWidth: bounds.minWidth,
      minHeight: bounds.minHeight,
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

    // 快照当前窗口状态。getNormalBounds 取「非最大化」尺寸，故最大化时记录的仍是还原后的正常大小；
    // 最大化态另存布尔位，下次启动据此恢复。
    const snapshot = (): WindowState => {
      const b = win.getNormalBounds();
      return { width: b.width, height: b.height, maximized: win.isMaximized() };
    };
    // 记住窗口大小 / 最大化：尺寸 resize 防抖回写，最大化切换即时回写（离散、低频）。写盘失败不影响使用。
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const persist = (): void => {
      if (win.isDestroyed()) return;
      this.windowState = snapshot();
      void writeWindowState(this.stateStore, this.windowState).catch((err: unknown) => {
        this.logger.warn({ err }, 'persist window state failed');
      });
    };
    const scheduleSave = (): void => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(persist, 400);
    };
    // 不监听 move：仅存尺寸（不存 x/y），位置变化无需回写。
    win.on('resize', scheduleSave);
    win.on('maximize', persist);
    win.on('unmaximize', persist);
    // 关窗同步落盘：close 后进程即退出，异步写来不及 flush（最大化 / resize 后秒关会丢状态）→ 同步写兜底。
    win.on('close', () => {
      if (win.isDestroyed()) return;
      if (saveTimer) clearTimeout(saveTimer);
      this.windowState = snapshot();
      try {
        writeWindowStateSync(this.stateDir, this.windowState);
      } catch (err) {
        this.logger.warn({ err }, 'persist window state on close failed');
      }
    });

    // 主界面首帧就绪：恢复最大化态 → 显示主窗口 → 关闭 splash，并记录进程启动→首帧耗时。
    // maximize 必须放到这里：建窗后即调用会让无边框窗口在内容就绪前以空白态抢先出现（盖过/早于 splash）。
    win.once('ready-to-show', () => {
      if (this.windowState.maximized) win.maximize();
      win.show();
      if (splash && !splash.isDestroyed()) splash.close();
      this.logger.info(
        { elapsedMs: Date.now() - this.startMs },
        'main window first paint (ready-to-show)',
      );
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
  }
}

/** 载入窗口状态（缺失/损坏 → 空对象，回退默认尺寸）并构造 WindowManager。 */
export async function loadWindowManager(deps: {
  stateStore: JsonFileStateStore;
  /** state 目录绝对路径（= JsonFileStateStore 的根目录）；关窗同步落盘用。 */
  stateDir: string;
  logger: Logger;
  startMs: number;
}): Promise<WindowManager> {
  const windowState: WindowState = await readWindowState(deps.stateStore).catch((err: unknown) => {
    deps.logger.warn({ err }, 'read window state failed; use default window size');
    return {};
  });
  return new WindowManager(deps.stateStore, deps.stateDir, deps.logger, deps.startMs, windowState);
}
