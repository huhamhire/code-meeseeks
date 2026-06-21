import { execSync } from 'node:child_process';
import { app } from 'electron';

/**
 * 进程 / 平台启动微调（须在模块加载期、app.whenReady() 之前跑一次）：
 * - PYTHONDONTWRITEBYTECODE=1：嵌入式 python 子进程不落 .pyc（安装目录 per-user 可写，运行期会积累上万
 *   __pycache__/.pyc 拖慢升级卸载）；子进程经 spawn 继承本进程 env。代价：每次启动重编译（略慢），影响有限。
 * - Windows chcp 65001：附着控制台默认本地化 OEM 页（简中 cp936/GBK），与 pino 的 UTF-8 字节对不上 →
 *   dev 终端中文日志乱码；切到 UTF-8 对齐。无控制台（打包态）chcp 静默失败、已吞，无副作用。
 * - macOS use-mock-keychain：ad-hoc 签名身份不稳定（cdhash 每次构建变），os_crypt 每次启动弹「访问钥匙串」；
 *   mock 让其走内存不碰真钥匙串。代价：cookie 加密退化为静态 key，但密钥本就明文落盘，无实质损失。
 *   有正式 Developer ID 签名后可移除。
 */
export function applyProcessStartupTweaks(): void {
  process.env.PYTHONDONTWRITEBYTECODE = '1';

  if (process.platform === 'win32') {
    try {
      execSync('chcp 65001', { stdio: 'ignore' });
    } catch {
      /* 无控制台 / chcp 不可用：忽略，日志仍按 UTF-8 字节写出 */
    }
  }

  if (process.platform === 'darwin') {
    app.commandLine.appendSwitch('use-mock-keychain');
  }
}
