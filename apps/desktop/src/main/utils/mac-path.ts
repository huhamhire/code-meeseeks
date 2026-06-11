import os from 'node:os';
import path from 'node:path';

/**
 * macOS GUI（Finder / Dock / LaunchServices）启动的 app 由 launchd 给出**最小 PATH**
 * （`/usr/bin:/bin:/usr/sbin:/sbin`），**不读用户 shell 配置**（`.zshrc` / `.zprofile`）。
 * 而本机 CLI（claude / codex）常装在 `~/.local/bin`、homebrew 等**只由 shell 往 PATH 里加**的
 * 目录——于是嵌入式 python 的 `shutil.which(...)` 找不到命令、本地 CLI provider 失效，但从终端
 * `npm run dev` 启动却正常（继承了已加载配置的终端 PATH）。Windows 不受影响（GUI 进程继承用户 PATH）。
 *
 * 这里在启动期把常见 CLI 安装目录前置进 `process.env.PATH`（仅 darwin），之后所有子进程
 * （嵌入式 python 及其 spawn 的 CLI）都经 `{ ...process.env }` 继承到。静态目录已覆盖最常见的
 * 安装位置；不跑登录 shell 解析（避免启动期子进程 / 超时 / 噪声）。
 */

// 常见 CLI 安装目录：覆盖 pip --user / npm global / homebrew(Apple Silicon + Intel)。
const COMMON_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
];

export interface MacPathResult {
  /** 是否实际改写了 PATH（仅 darwin 且确有目录新增时为 true）。 */
  applied: boolean;
  /** 本次新前置、原 PATH 中没有的目录（供日志诊断）。 */
  added: string[];
}

/**
 * 仅 darwin：把常见目录前置进 `process.env.PATH`（去重，只补原 PATH 缺失的，保持原有顺序在后）。
 * 非 darwin 直接 no-op。返回补全详情供日志。
 */
export function fixMacPath(): MacPathResult {
  if (process.platform !== 'darwin') {
    return { applied: false, added: [] };
  }
  const existing = (process.env.PATH ?? '').split(':').filter(Boolean);
  const existingSet = new Set(existing);
  const added = COMMON_DIRS.filter((d) => !existingSet.has(d));
  if (added.length > 0) {
    process.env.PATH = [...added, ...existing].join(':');
  }
  return { applied: added.length > 0, added };
}
