import type { AppInfo, AppPaths, PrAgentStatus, UpdateCheckResult } from '@meebox/shared';
import type { ConnectionSummary } from './common.js';

/** GUI framework interaction domain: app info / framework window / external open / dialogs / log relay / connections and avatars. */
export interface AppChannels {
  'app:info': { request: void; response: AppInfo };
  'app:paths': { request: void; response: AppPaths };
  'app:prAgentStatus': { request: void; response: PrAgentStatus };
  /** Call Electron shell.openPath to let the OS default editor open config.yaml */
  'app:openConfigFile': { request: void; response: void };
  /** Call shell.openPath to open the currently effective Agent directory in the system file manager (create it first if it doesn't exist). */
  'app:openAgentDir': { request: void; response: void };
  /** Open Electron DevTools (detached window) */
  'app:openDevTools': { request: void; response: void };
  /**
   * Set the app badge count (macOS dock). The renderer derives the "@me / replies to me" pending-response total from the PR list and pushes it; the main process decides
   * whether to actually show it per notification config and platform (macOS only this iteration). count=0 clears the badge.
   */
  'app:setBadgeCount': { request: { count: number }; response: void };
  /** Manually check for a version update (Settings page "Check for updates"). Only checks + returns the result, no download / install;
   *  the result is also cached into main's single source of truth and, when a new version exists, broadcasts app:updateAvailable to keep the status bar in sync. */
  'app:checkUpdate': { request: void; response: UpdateCheckResult };
  /** Read main's cached most-recent successful update-check result (does not make a network request). Used to hydrate on window / status bar mount,
   *  returns null when there's no cache (never checked). */
  'app:getUpdateStatus': { request: void; response: UpdateCheckResult | null };
  /**
   * Renderer log relay: forward the renderer's errors / uncaught exceptions to main, landing in the same meebox.log
   * (the renderer's own console doesn't go to file). preload installs window.onerror / unhandledrejection
   * to call it. `scope` is fixed 'renderer', `meta` is any structured context (e.g. stack / url).
   */
  'log:write': {
    request: {
      level: 'error' | 'warn' | 'info' | 'debug';
      msg: string;
      meta?: Record<string, unknown>;
    };
    response: void;
  };
  /**
   * Open a URL in the system default browser (shell.openExternal). Clicking an inline link in comment markdown → force
   * external open, avoiding Electron navigating within the app window and covering the whole interface
   */
  'app:openExternal': { request: { url: string }; response: void };
  /**
   * Open the macOS "System Settings → Notifications" panel to guide the user to grant / enable notification permission (macOS governs notification authorization at the system level,
   * the app cannot enable it on their behalf). Effective on macOS only, a no-op on other platforms.
   */
  'app:openNotificationSettings': { request: void; response: void };
  /**
   * Invoke the native system directory-picker dialog; returns path: null when the user cancels.
   * defaultPath is optional, used as the initial location directory.
   */
  'dialog:pickDirectory': {
    // title is provided by the frontend per UI language (interaction-domain text is maintained uniformly in renderer i18n); defaultPath serves as the initial location directory.
    request: { defaultPath?: string; title: string };
    response: { path: string | null };
  };
  /**
   * The renderer, after applying the theme, pushes the window-control button colors derived from the current theme (Windows titleBarOverlay: color=--bg-app,
   * symbolColor=--text-primary), so the system window-control buttons exactly match the specific theme's title-bar background; null falls back to generic dark / light.
   */
  'window:setControlColors': {
    request: { color: string; symbolColor: string } | null;
    response: void;
  };
  /** Each connection's post-ping cache: current user + display_name, used by the Header */
  'app:connections': { request: void; response: ConnectionSummary[] };
  /**
   * Fetch a user avatar data URL by (connectionId, slug); returns directly on a main-process cache hit.
   * Returns null when the platform is unsupported / network fails / the user has no avatar, and the renderer takes the initials fallback.
   */
  'app:userAvatar': {
    // avatarUrl is optional: the direct avatar link returned by the platform (GitHub bots must rely on it); when omitted, main derives it from slug
    request: { connectionId: string; slug: string; avatarUrl?: string };
    response: { dataUrl: string } | null;
  };
}
