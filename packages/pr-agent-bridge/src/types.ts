import type { PrAgentStrategy } from '@pr-pilot/shared';

/** pr-agent 子命令枚举；跟 @pr-pilot/shared 的 ReviewRunTool 同集合 */
export type PrAgentTool = 'describe' | 'review' | 'ask';

export interface PrAgentRunOptions {
  /**
   * pr-agent 入口 `--pr_url`。
   * - 远端模式：BBS PR URL，如 https://host/projects/.../pull-requests/<id>
   * - 本地模式 (cwd 已配置)：直接传 cwd 路径（容器里固定为 /repo），pr-agent 拿来
   *   定位本地仓库目录，不会走任何远端 API
   */
  prUrl: string;
  tool: PrAgentTool;
  /** 注入到子进程的环境变量（LLM key / platform token / config 覆盖） */
  env?: Record<string, string>;
  /** 追加到 CLI 末尾的参数（如 --extra_instructions / --config_file） */
  extraArgs?: string[];
  /** 单次调用超时，默认 5 min */
  timeoutMs?: number;
  /** stdout / stderr 整行流式推送（M3-B UI 进度提示用） */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /**
   * 用户主动取消信号。abort 后 SIGKILL 子进程，reject 为 PrAgentRunError reason='cancelled'。
   * 不传则永不取消，仅 timeoutMs 兜底。
   */
  signal?: AbortSignal;
  /**
   * 本地工作树绝对路径。配置后切到 `git_provider=local` 模式：
   * - LocalCli: 把 cwd 作为子进程工作目录 + `--pr_url <cwd>` 传给 pr-agent
   * - Docker: `-v <cwd>:/repo -w /repo` + `--pr_url /repo`
   *
   * 完全不出网到 BBS，pr-agent 自己跑 `git diff <targetBranch>...HEAD`。
   * 不设置则走原远端 provider 模式（默认 prUrl 远端拉 PR）。
   */
  cwd?: string;
  /**
   * 本地 diff 起点。仅 `cwd` 设置时生效；典型值是 PR base sha 或 ref 名。
   * 传给 pr-agent 的 `--target_branch`；缺省时 pr-agent 自己 fallback 到默认分支。
   */
  targetBranch?: string;
  /**
   * 仅 Docker 策略生效，给 docker 调用追加额外的 `-v host:container[:ro]` 挂载。
   * 当前主要用于把宿主端的空 `.secrets.toml` 挂到容器内 pr-agent 期望但实际没用
   * 的 secrets 路径上，抑制启动告警。LocalCli 策略下忽略此字段。
   */
  dockerExtraVolumes?: ReadonlyArray<{
    host: string;
    container: string;
    readonly?: boolean;
  }>;
}

export interface PrAgentRunResult {
  /** 子进程完整 stdout 文本 */
  stdout: string;
  /** 子进程完整 stderr 文本 */
  stderr: string;
  /** 退出码；信号被杀 / 启动失败时为 -1 */
  exitCode: number;
  /** 运行墙钟时间 (ms) */
  durationMs: number;
}

export type PrAgentRunFailureReason =
  /** 超时被 SIGKILL */
  | 'timeout'
  /** 子进程未能启动（ENOENT / 权限 / fork 失败） */
  | 'spawn-failed'
  /** 正常退出但 exit code != 0 */
  | 'non-zero-exit'
  /** 被外部信号杀死（非超时） */
  | 'killed'
  /** 用户主动取消 (AbortSignal abort) */
  | 'cancelled';

/** pr-agent 跑失败时抛出；携带原因 + 已收集的 stdout / stderr / exitCode 供 UI 展示 */
export class PrAgentRunError extends Error {
  constructor(
    message: string,
    public readonly reason: PrAgentRunFailureReason,
    public readonly result: Partial<PrAgentRunResult> = {},
  ) {
    super(message);
    this.name = 'PrAgentRunError';
  }
}

export interface ExecOptions {
  timeoutMs: number;
  env?: Record<string, string>;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** 子进程工作目录；LocalCli 本地模式用，Docker 不需要（容器 cwd 走 -w /repo） */
  cwd?: string;
  /** 用户主动取消信号；abort 后 SIGKILL 子进程并 reject reason='cancelled' */
  signal?: AbortSignal;
}

/**
 * 注入式子进程执行接口：默认实现走 node:child_process.spawn，单测可注入 fake 版本
 * 不依赖真实 Node 子进程。Bridge 层不直接 import spawn，只依赖此接口。
 */
export type ExecFn = (cmd: string, args: string[], opts: ExecOptions) => Promise<PrAgentRunResult>;

export interface PrAgentBridge {
  /** 解析后选中的策略名 */
  readonly strategy: PrAgentStrategy;
  /** 探测时拿到的版本字符串（CLI --version 首行或 docker --version） */
  readonly version: string;
  /** 跑 /describe；等价 run({ ...opts, tool: 'describe' }) */
  describe(opts: Omit<PrAgentRunOptions, 'tool'>): Promise<PrAgentRunResult>;
  /** 跑 /review；等价 run({ ...opts, tool: 'review' }) */
  review(opts: Omit<PrAgentRunOptions, 'tool'>): Promise<PrAgentRunResult>;
  /** 通用入口；后续加 /ask /improve 时直接用 run */
  run(opts: PrAgentRunOptions): Promise<PrAgentRunResult>;
}
