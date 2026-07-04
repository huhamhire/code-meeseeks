export interface AppPaths {
  /** ~/.code-meeseeks/ — fixed application root */
  appDir: string;
  /** config.yaml absolute path */
  configFile: string;
  /** state/ subdir */
  stateDir: string;
  /** archived/ subdir — cold store for retired PRs (sibling of state/); archived PR trees relocate here and follow the same purge lifecycle */
  archivedDir: string;
  /** logs/ subdir */
  logsDir: string;
  /** agent/ subdir — default Agent directory location (SOUL/AGENTS/MEMORY/USER + rules/) */
  agentDir: string;
  /** cache/ subdir — transient rebuildable data (avatars etc.), may be cleared externally */
  cacheDir: string;
  /** repos_dir resolved from config (may differ from default) */
  reposDir: string;
}

/** Matches Node.js's process.platform literals exactly, but without pulling in the NodeJS namespace,
 * so the renderer (which does not include @types/node) can also consume the shared type. */
export type Platform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd';

export interface AppInfo {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  platform: Platform;
  /** OS marketing version (e.g. macOS "15.5", Windows "10.0.22631") via Electron process.getSystemVersion() */
  osVersion: string;
  /** CPU architecture (process.arch, e.g. "arm64" / "x64") */
  arch: string;
  /** ~/.code-meeseeks was newly created on this run */
  firstRun: boolean;
}

/**
 * Version update check result. Detects + notifies only, does not auto download / install.
 * - ok=false: the check did not complete (network / parse failure), error gives the reason; hasUpdate is always false.
 * - ok=true: the check completed; hasUpdate indicates whether a newer version exists.
 */
export interface UpdateCheckResult {
  ok: boolean;
  hasUpdate: boolean;
  currentVersion: string;
  /** Latest stable version number (given when ok=true) */
  latestVersion?: string;
  /** Release page URL of the latest version (given when hasUpdate=true, for the user to download manually) */
  url?: string;
  /** Release time of the latest version, ISO (optional) */
  publishedAt?: string;
  /** Failure reason when ok=false */
  error?: string;
}
