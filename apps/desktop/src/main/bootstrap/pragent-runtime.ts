import path from 'node:path';
import type { BootstrapResult } from '@meebox/config';
import { createPrAgentBridge, type PrAgentBridge } from '@meebox/pr-agent-bridge';
import type { PrAgentStatus } from '@meebox/shared';
import { app } from 'electron';
import type { Logger } from 'pino';

/**
 * pr-agent runtime: resolves the embedded interpreter path + kicks off the probe (starts on
 * construction, not awaited), result backfilled asynchronously. The probe is **kept off the
 * window-creation critical path**—it runs a spawn probe (auto fallback to local-cli, worst case 5s),
 * and awaiting it would delay the first paint by seconds; instead the kick-off runs concurrently with
 * whenReady + renderer load. The bridge is backfilled asynchronously by the probe, so a class holds
 * the mutable state.
 * - probe: app:prAgentStatus awaits this for the final status (usually already done by boot time).
 * - getBridge(): read at the pragent run entry, null when not ready → falls back to a "not ready" prompt.
 */
export class PrAgentRuntime {
  /** Absolute path to the embedded interpreter (the probe layer uses it to judge embedded availability; falls back to local-cli if the file is missing). */
  readonly embeddedPythonPath: string;
  /** Probe promise (construction logic guarantees it always resolves, never rejects). */
  readonly probe: Promise<PrAgentStatus>;
  private bridge: PrAgentBridge | null = null;

  constructor(
    private readonly bootstrap: BootstrapResult,
    private readonly logger: Logger,
  ) {
    this.embeddedPythonPath = PrAgentRuntime.resolveEmbeddedPython();
    this.probe = this.kickoffProbe();
  }

  /** null until the probe completes. */
  getBridge(): PrAgentBridge | null {
    return this.bridge;
  }

  /**
   * Absolute path to the interpreter of the embedded pr-agent runtime.
   * - dev: `apps/desktop/vendor/pragent/...` (app.getAppPath() = apps/desktop)
   * - packaged: `<resources>/pragent/...` (electron-builder extraResources)
   * - `MEEBOX_PRAGENT_PYTHON` env override fallback
   */
  private static resolveEmbeddedPython(): string {
    const override = process.env.MEEBOX_PRAGENT_PYTHON;
    if (override) return override;
    const rel =
      process.platform === 'win32' ? ['python', 'python.exe'] : ['python', 'bin', 'python3'];
    const base = app.isPackaged
      ? path.join(process.resourcesPath, 'pragent')
      : path.join(app.getAppPath(), 'vendor', 'pragent');
    return path.join(base, ...rel);
  }

  private kickoffProbe(): Promise<PrAgentStatus> {
    return (async (): Promise<PrAgentStatus> => {
      const probe = await createPrAgentBridge({
        embeddedPythonPath: this.embeddedPythonPath,
        forceStrategy: this.bootstrap.config.pr_agent.strategy,
      });
      this.bridge = probe.bridge;
      this.logger.info(
        {
          available: probe.status.available,
          strategy: probe.status.available ? probe.status.strategy : undefined,
          version: probe.status.available ? probe.status.version : undefined,
        },
        'pr-agent probe complete',
      );
      return probe.status;
    })();
  }
}
