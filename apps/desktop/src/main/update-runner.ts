import type { BootstrapResult } from '@meebox/config';
import { app } from 'electron';
import type { Logger } from 'pino';
import { checkForUpdate } from './utils/update-check.js';
import { publishUpdateResult } from './utils/update-state.js';

// 至多每小时一次（复用 poller 周期，不另起定时器）。
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 版本更新检测节流器：由 poller tick 顺带调 runIfDue，内部时间戳门控至多每小时一次。lastCheckMs 初值取
 * 构造时刻 → 首次检测落在启动后约 1h，刻意不在启动瞬间检测（避免占冷启动网络 / 打断启动）。仅检测 + 提示：
 * 有新版才广播给所有窗口；失败静默（绝不推任何 IPC，对用户零打扰）。节流状态是实例字段，故以 class 封装。
 */
export class UpdateRunner {
  private lastCheckMs = Date.now();

  constructor(
    private readonly bootstrap: BootstrapResult,
    private readonly logger: Logger,
  ) {}

  /** 满足开关 + 距上次满 1h 时发起一次检测。时间戳在 await 前更新，避免窗口内下一次 tick 重复发起。 */
  async runIfDue(): Promise<void> {
    if (!this.bootstrap.config.update.check_enabled) return;
    if (Date.now() - this.lastCheckMs < UPDATE_CHECK_INTERVAL_MS) return;
    this.lastCheckMs = Date.now();
    try {
      const result = await checkForUpdate(app.getVersion(), this.bootstrap.config.proxy);
      // 获取失败（网络 / 解析 / 超时 / 限流，ok=false）：只记 debug，**绝不推任何 IPC** → 用户无感。
      if (!result.ok) {
        this.logger.debug({ error: result.error }, 'update check failed (silent, no prompt)');
        return;
      }
      // 交给单一真相源：缓存结果，仅在确有新版时广播（与设置页手动检查共用同一路径）。
      publishUpdateResult(result);
      if (result.hasUpdate) {
        this.logger.info(
          { current: result.currentVersion, latest: result.latestVersion },
          'update available',
        );
      }
    } catch (err) {
      // 兜底：checkForUpdate 约定不抛；万一抛了也吞掉，绝不冒泡成任何用户可见行为。
      this.logger.debug({ err }, 'update check threw (silent, no prompt)');
    }
  }
}
