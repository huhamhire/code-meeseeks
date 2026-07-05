// **Single source of truth** for the version update check: both the manual check (settings page app:checkUpdate)
// and the scheduled check (runUpdateCheckIfDue) hand their result here, for unified caching + broadcasting to all windows when a new version is confirmed.
// This way a manually found new version syncs to the status bar, and any window / status bar can, on mount, hydrate
// the known result via app:getUpdateStatus (no need to wait for the next broadcast / re-initiate a network call). In-process cache, not persisted — refilled by the next check after restart.

import { BrowserWindow } from 'electron';
import type { UpdateCheckResult } from '@meebox/shared';

let lastResult: UpdateCheckResult | null = null;

/** The most recent **successful** (ok=true) check result; null when no successful check has occurred yet. */
export function getLastUpdateResult(): UpdateCheckResult | null {
  return lastResult;
}

/**
 * Record a check result and broadcast as needed. A failure (ok=false) neither overwrites a known good result nor broadcasts — guaranteeing
 * "network unreachable" causes zero disturbance to the user; a successful result (regardless of hasUpdate) overwrites the cache, but only hasUpdate pushes
 * app:updateAvailable (consistent with the existing "notify only on a new version" design).
 */
export function publishUpdateResult(result: UpdateCheckResult): void {
  if (!result.ok) return;
  lastResult = result;
  if (!result.hasUpdate) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('app:updateAvailable', result);
  }
}
