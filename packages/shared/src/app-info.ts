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
  /** agent/ subdir — 默认 Agent 目录位置（SOUL/AGENTS/MEMORY/USER + rules/） */
  agentDir: string;
  /** cache/ subdir — 临时性可重建数据 (avatars 等)，可被外部清空 */
  cacheDir: string;
  /** repos_dir resolved from config (may differ from default) */
  reposDir: string;
}

/** 与 Node.js 的 process.platform 字面量完全匹配，但不引入 NodeJS 命名空间，
 * 这样 renderer (不挂 @types/node) 也能消费 shared 类型。 */
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
 * 版本更新检测结果。仅检测 + 提示，不自动下载 / 安装。
 * - ok=false：检测未完成（网络 / 解析失败），error 给原因；hasUpdate 恒 false。
 * - ok=true：检测完成；hasUpdate 表示是否有更新版本。
 */
export interface UpdateCheckResult {
  ok: boolean;
  hasUpdate: boolean;
  currentVersion: string;
  /** 最新稳定版版本号（ok=true 时给出） */
  latestVersion?: string;
  /** 最新版 Release 页 URL（hasUpdate=true 时给出，供用户手动下载） */
  url?: string;
  /** 最新版发布时间 ISO（可选） */
  publishedAt?: string;
  /** ok=false 时的失败原因 */
  error?: string;
}
