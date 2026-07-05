import { app, BrowserWindow, nativeTheme, screen, shell } from 'electron';
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

// Default window size (when there is no local record). The minimum size guarantees the core three
// columns (sidebar 240 + file-tree 180 + diff content) remain usable with the chat-pane collapsed;
// the height accommodates pr-header + tabs + diff + statusbar. Units are all DIP (device-independent pixels).
const DEFAULT_SIZE = { width: 1280, height: 800 };
const MIN_SIZE = { width: 960, height: 600 };

// Colors of the system window-control buttons on the right of the self-drawn title bar (Windows
// titleBarOverlay): same color as the .app-titlebar background (--bg-app), so the seam is invisible;
// the symbol takes the primary text color. Dark/light sets, following the effective theme
// (nativeTheme.shouldUseDarkColors). Values align with palette dark/light bg-app
// ($vscode-gray-850 / $vscode-gray-30) and primary text ($vscode-gray-200 / $vscode-gray-840).
const TITLE_BAR_OVERLAY = {
  dark: { color: '#1e1e1e', symbolColor: '#cccccc' },
  light: { color: '#f8f8f8', symbolColor: '#1f1f20' },
};
// Renderer-derived window-control colors (following the specific theme's --bg-app/--text-primary, hex); when null, falls back to generic colors by nativeTheme dark/light.
let overlayColors: { color: string; symbolColor: string } | null = null;
/** Generic dark/light window-control colors (fallback when there is no renderer-derived color, by nativeTheme effective dark/light). */
function genericOverlayColors(): { color: string; symbolColor: string } {
  return nativeTheme.shouldUseDarkColors ? TITLE_BAR_OVERLAY.dark : TITLE_BAR_OVERLAY.light;
}
/** Current window-control overlay (renderer-derived color first, otherwise generic color) + height (36px, matching .app-titlebar). */
function currentOverlay(): { color: string; symbolColor: string; height: number } {
  return { ...(overlayColors ?? genericOverlayColors()), height: 36 };
}
/**
 * Called by the renderer via IPC after the theme is applied: sets the current theme-derived
 * window-control colors (color=--bg-app, symbolColor=--text-primary) on all windows; passing null
 * falls back to generic dark/light colors. Makes the window-control buttons exactly match the specific
 * theme's title-bar background, rather than only generic dark/light.
 */
export function setWindowControlColors(colors: { color: string; symbolColor: string } | null): void {
  overlayColors = colors;
  if (process.platform === 'darwin') return; // macOS has no titleBarOverlay
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.setTitleBarOverlay(currentOverlay());
    } catch {
      /* platform does not support setTitleBarOverlay → ignore */
    }
  }
}

/**
 * Resolves the window size/position: clamps the desired size (local record first, falling back to
 * default) into the **current display's work area**, and lowers the minimum size accordingly—otherwise
 * under high-DPI scaling the work area (DIP) may be smaller than the default/minimum, and the window
 * gets stretched off-screen (issue: default size exceeds screen after scaling). Takes the display under
 * the cursor (on multi-screen this better matches "where to open"), centers within its work area, and
 * guarantees the whole window stays on-screen (does not persist x/y, only positions at creation).
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
 * Main window manager: window creation (restore size + self-drawn title bar + external-link routing +
 * first-paint show/close splash) + debounced write-back on resize/move/close.
 * windowState is instance-mutable state (kept up to date across multiple create calls—e.g. macOS
 * activate re-creation), so it is wrapped in a class; async loading is done by loadWindowManager
 * (construction is synchronous, holds nothing async).
 */
export class WindowManager {
  constructor(
    private readonly stateStore: JsonFileStateStore,
    /** Absolute path of the state directory; used for the synchronous write-to-disk fallback on window close (see writeWindowStateSync). */
    private readonly stateDir: string,
    private readonly logger: Logger,
    /** Process start moment, used to measure the startup elapsed time to the first paint (ready-to-show). */
    private readonly startMs: number,
    /** Current window state (size/maximized); written back on resize/maximize/close. */
    private windowState: WindowState,
  ) {}

  /** Creates the main window (the first call passes splash, closed when the main UI's first paint is ready; macOS activate re-creation does not pass it). */
  create(splash?: BrowserWindow): void {
    // Size/position: local record first, falling back to default, and clamped + centered within the current display's work area (prevents overflowing the screen under high-DPI scaling).
    const bounds = resolveWindowBounds(this.windowState);
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      minWidth: bounds.minWidth,
      minHeight: bounds.minHeight,
      show: false,
      // Window background before the first paint matches the app, to avoid a white flash at the display instant
      backgroundColor: '#1e1e1e',
      // Frameless + self-drawn title bar (VS Code style): macOS keeps the traffic lights and shifts them
      // down into the self-drawn title bar; Windows/Linux use titleBarOverlay to let the system keep
      // drawing the window-control buttons, with the renderer taking over only the middle title area. Height must match .app-titlebar (36px).
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 12, y: 11 } }
        : { titleBarOverlay: currentOverlay() }),
      // In dev, explicitly set the window icon; in packaged mode the window/taskbar icon comes from the exe embed (electron-builder), so only set it in dev.
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

    // Snapshot the current window state. getNormalBounds takes the "non-maximized" size, so what is
    // recorded while maximized is still the restored normal size; the maximized state is stored separately as a boolean, restored on next startup.
    const snapshot = (): WindowState => {
      const b = win.getNormalBounds();
      return { width: b.width, height: b.height, maximized: win.isMaximized() };
    };
    // Remember window size / maximized: size resize is written back debounced, maximize toggles are written back immediately (discrete, low frequency). Write failures do not affect usage.
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
    // Do not listen to move: only size is stored (not x/y), so position changes need no write-back.
    win.on('resize', scheduleSave);
    win.on('maximize', persist);
    win.on('unmaximize', persist);
    // Synchronous write-to-disk on close: after close the process exits immediately, and an async write cannot flush in time (closing within a second of maximize / resize would lose state) → synchronous write fallback.
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

    // Main UI first paint ready: restore maximized state → show main window → close splash, and record the process-start→first-paint elapsed time.
    // maximize must go here: calling it right after window creation would make the frameless window appear prematurely in a blank state before content is ready (covering/preceding the splash).
    win.once('ready-to-show', () => {
      if (this.windowState.maximized) win.maximize();
      win.show();
      if (splash && !splash.isDestroyed()) splash.close();
      this.logger.info(
        { elapsedMs: Date.now() - this.startMs },
        'main window first paint (ready-to-show)',
      );
    });

    // Under the 'auto' theme, nativeTheme emits 'updated' on OS dark/light changes: reset the
    // window-control colors as a fallback by the current overlay (renderer-derived color first, otherwise
    // generic color) (macOS has no titleBarOverlay, not registered). The specific theme's exact colors are
    // actively pushed by the renderer via setWindowControlColors (see useGlobalTheme); here it only falls back by nativeTheme dark/light when the renderer has not pushed.
    if (process.platform !== 'darwin') {
      const onThemeUpdated = (): void => {
        if (win.isDestroyed()) return;
        try {
          win.setTitleBarOverlay(currentOverlay());
        } catch {
          /* platform does not support setTitleBarOverlay → ignore */
        }
      };
      nativeTheme.on('updated', onThemeUpdated);
      win.on('closed', () => nativeTheme.off('updated', onThemeUpdated));
    }

    // Route both <a target="_blank"> / window.open to the OS default browser, not opening new windows inside Electron.
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

/** Loads the window state (missing/corrupt → empty object, falling back to default size) and constructs the WindowManager. */
export async function loadWindowManager(deps: {
  stateStore: JsonFileStateStore;
  /** Absolute path of the state directory (= JsonFileStateStore's root); used for the synchronous write-to-disk on window close. */
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
