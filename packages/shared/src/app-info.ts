export interface AppPaths {
  /** ~/.code-meeseeks/ — fixed application root */
  appDir: string;
  /** config.yaml absolute path */
  configFile: string;
  /** state/ subdir */
  stateDir: string;
  /** logs/ subdir */
  logsDir: string;
  /** rules/ subdir */
  rulesDir: string;
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
  /** ~/.code-meeseeks was newly created on this run */
  firstRun: boolean;
}
