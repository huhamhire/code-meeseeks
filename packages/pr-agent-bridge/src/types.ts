import type { PrAgentStrategy } from '@pr-pilot/shared';

/** M3 一期接 pr-agent 的两个核心 tool；后续 /ask /improve 等可加 */
export type PrAgentTool = 'describe' | 'review';

export interface PrAgentRunOptions {
  /** pr-agent 入口 --pr_url；BBS 走 https://host/projects/.../pull-requests/<id> */
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
  | 'killed';

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
