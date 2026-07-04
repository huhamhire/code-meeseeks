import type { BootstrapResult } from '@meebox/config';
import { app } from 'electron';
import type { Logger } from 'pino';
import { checkForUpdate } from '../utils/update-check.js';
import { publishUpdateResult } from '../utils/update-state.js';

// At most once per hour (reuses the poller cycle, no separate timer).
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Version-update check throttler: the poller tick incidentally calls runIfDue, and an internal
 * timestamp gates it to at most once per hour. lastCheckMs is initialized to the construction moment →
 * the first check lands about 1h after startup, deliberately not checking at the startup instant (to
 * avoid taking cold-start network / interrupting startup). Detect + prompt only: broadcasts to all
 * windows only when a new version exists; failures are silent (never pushes any IPC, zero user
 * disturbance). The throttle state is an instance field, so it is wrapped in a class.
 */
export class Updater {
  private lastCheckMs = Date.now();

  constructor(
    private readonly bootstrap: BootstrapResult,
    private readonly logger: Logger,
  ) {}

  /** Fires a check when the toggle is on and 1h has elapsed since the last one. The timestamp is updated before the await, to avoid the next tick within the window firing again. */
  async runIfDue(): Promise<void> {
    if (!this.bootstrap.config.update.check_enabled) return;
    if (Date.now() - this.lastCheckMs < UPDATE_CHECK_INTERVAL_MS) return;
    this.lastCheckMs = Date.now();
    try {
      const result = await checkForUpdate(app.getVersion(), this.bootstrap.config.proxy);
      // Fetch failure (network / parse / timeout / rate-limit, ok=false): only log debug, **never push any IPC** → user unaware.
      if (!result.ok) {
        this.logger.debug({ error: result.error }, 'update check failed (silent, no prompt)');
        return;
      }
      // Hand off to the single source of truth: cache the result, broadcast only when a new version truly exists (shares the same path as the settings-page manual check).
      publishUpdateResult(result);
      if (result.hasUpdate) {
        this.logger.info(
          { current: result.currentVersion, latest: result.latestVersion },
          'update available',
        );
      }
    } catch (err) {
      // Fallback: checkForUpdate is contracted not to throw; swallow it even if it does, never bubbling into any user-visible behavior.
      this.logger.debug({ err }, 'update check threw (silent, no prompt)');
    }
  }
}
