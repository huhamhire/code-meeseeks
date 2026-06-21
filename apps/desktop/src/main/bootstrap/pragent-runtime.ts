import path from 'node:path';
import type { BootstrapResult } from '@meebox/config';
import { createPrAgentBridge, type PrAgentBridge } from '@meebox/pr-agent-bridge';
import type { PrAgentStatus } from '@meebox/shared';
import { app } from 'electron';
import type { Logger } from 'pino';

/**
 * pr-agent 运行时：解析嵌入式解释器路径 + kick-off 探测（构造即开跑、不 await），结果异步回填。探测**不放
 * 在建窗关键路径**——它走 spawn 探测（auto 回退 local-cli 最坏 5s），await 会把首帧推迟数秒；改 kick-off
 * 与 whenReady + 渲染层加载并发跑。bridge 由探测异步回填，故以 class 持有可变态。
 * - probe：app:prAgentStatus 据此 await 拿最终状态（boot 时序通常已完成）。
 * - getBridge()：pragent run 入口读，未就绪时为 null → 走「未就绪」提示。
 */
export class PrAgentRuntime {
  /** 嵌入式解释器绝对路径（探测层据此判 embedded 是否可用，文件不存在则回退 local-cli）。 */
  readonly embeddedPythonPath: string;
  /** 探测 promise（构造逻辑保证恒 resolve、不 reject）。 */
  readonly probe: Promise<PrAgentStatus>;
  private bridge: PrAgentBridge | null = null;

  constructor(
    private readonly bootstrap: BootstrapResult,
    private readonly logger: Logger,
  ) {
    this.embeddedPythonPath = PrAgentRuntime.resolveEmbeddedPython();
    this.probe = this.kickoffProbe();
  }

  /** 探测完成前为 null。 */
  getBridge(): PrAgentBridge | null {
    return this.bridge;
  }

  /**
   * 嵌入式 pr-agent 运行时的解释器绝对路径。
   * - dev：`apps/desktop/vendor/pragent/...`（app.getAppPath() = apps/desktop）
   * - 打包：`<resources>/pragent/...`（electron-builder extraResources）
   * - `MEEBOX_PRAGENT_PYTHON` env 覆盖兜底
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
