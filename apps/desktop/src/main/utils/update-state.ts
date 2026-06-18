// 版本更新检测的**单一真相源**：手动检查（设置页 app:checkUpdate）与定时检查
// （runUpdateCheckIfDue）都把结果交给这里，统一缓存 + 在确有新版时广播给所有窗口。
// 这样手动查到的新版能同步到状态栏，且任意窗口 / 状态栏挂载时可经 app:getUpdateStatus 水合
// 已知结果（不必等下一次广播 / 重新发起网络）。进程内缓存，不落盘——重启后由下次检查重填。

import { BrowserWindow } from 'electron';
import type { UpdateCheckResult } from '@meebox/shared';

let lastResult: UpdateCheckResult | null = null;

/** 最近一次**成功**（ok=true）的检测结果；尚未成功检测过时为 null。 */
export function getLastUpdateResult(): UpdateCheckResult | null {
  return lastResult;
}

/**
 * 记录一次检测结果并按需广播。失败（ok=false）不覆盖已知好结果、也不广播——保证
 * 「网络拿不到」对用户零打扰；成功结果（无论 hasUpdate）覆盖缓存，仅 hasUpdate 才推
 * app:updateAvailable（与既有「仅有新版才提示」的设计一致）。
 */
export function publishUpdateResult(result: UpdateCheckResult): void {
  if (!result.ok) return;
  lastResult = result;
  if (!result.hasUpdate) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('app:updateAvailable', result);
  }
}
