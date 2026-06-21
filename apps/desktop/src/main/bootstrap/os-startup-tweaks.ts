import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

// 常见 CLI 安装目录：覆盖 pip --user / npm global / homebrew(Apple Silicon + Intel)。
const COMMON_CLI_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
];

/**
 * macOS GUI（Finder / Dock / LaunchServices）启动的 app 由 launchd 给出**最小 PATH**
 * （`/usr/bin:/bin:/usr/sbin:/sbin`），**不读用户 shell 配置**（`.zshrc` / `.zprofile`）。
 * 而本机 CLI（claude / codex）常装在 `~/.local/bin`、homebrew 等**只由 shell 往 PATH 里加**的
 * 目录——于是嵌入式 python 的 `shutil.which(...)` 找不到命令、本地 CLI provider 失效，但从终端
 * `npm run dev` 启动却正常（继承了已加载配置的终端 PATH）。Windows 不受影响（GUI 进程继承用户 PATH）。
 *
 * 把常见目录前置进 `process.env.PATH`（去重，只补原 PATH 缺失的，保持原有顺序在后）；之后所有子进程
 * （嵌入式 python 及其 spawn 的 CLI）都经 `{ ...process.env }` 继承到。静态目录已覆盖最常见的安装位置；
 * 不跑登录 shell 解析（避免启动期子进程 / 超时 / 噪声）。仅由 applyMacStartupTweaks 调用。
 */
function augmentMacPath(): void {
  const existing = (process.env.PATH ?? '').split(':').filter(Boolean);
  const existingSet = new Set(existing);
  const added = COMMON_CLI_DIRS.filter((d) => !existingSet.has(d));
  if (added.length > 0) {
    process.env.PATH = [...added, ...existing].join(':');
  }
}

/**
 * Windows 专属启动微调：附着控制台默认本地化 OEM 页（简中 cp936/GBK），与 pino 的 UTF-8 字节对不上 →
 * dev 终端中文日志乱码；chcp 65001 把输出代码页切到 UTF-8 对齐。无控制台（打包态）chcp 静默失败、已吞，
 * 无副作用。
 */
function applyWindowsStartupTweaks(): void {
  try {
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch {
    /* 无控制台 / chcp 不可用：忽略，日志仍按 UTF-8 字节写出 */
  }
}

/**
 * macOS 专属启动微调：
 * - use-mock-keychain：ad-hoc 签名身份不稳定（cdhash 每次构建变），os_crypt 每次启动弹「访问钥匙串」；
 *   mock 让其走内存不碰真钥匙串。代价：cookie 加密退化为静态 key，但密钥本就明文落盘，无实质损失。
 *   有正式 Developer ID 签名后可移除。须在 app.whenReady() 之前。
 * - PATH 前置常见 CLI 目录（见 augmentMacPath）：须在 pr-agent 探测 / 运行前。
 */
function applyMacStartupTweaks(): void {
  app.commandLine.appendSwitch('use-mock-keychain');
  augmentMacPath();
}

/**
 * 进程 / 平台启动微调（须在模块加载期、app.whenReady() 之前跑一次）：先做跨平台的进程 env 调整，再按
 * 当前平台委托各自的专属初始化（见 applyWindowsStartupTweaks / applyMacStartupTweaks）。
 *
 * 跨平台：PYTHONDONTWRITEBYTECODE=1——嵌入式 python 子进程不落 .pyc（安装目录 per-user 可写，运行期会
 * 积累上万 __pycache__/.pyc 拖慢升级卸载）；子进程经 spawn 继承本进程 env。代价：每次启动重编译（略慢），
 * 影响有限。
 */
export function applyOsStartupTweaks(): void {
  process.env.PYTHONDONTWRITEBYTECODE = '1';

  if (process.platform === 'win32') {
    applyWindowsStartupTweaks();
  } else if (process.platform === 'darwin') {
    applyMacStartupTweaks();
  }
}
