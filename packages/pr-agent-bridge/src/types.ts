import type { PrAgentStrategy } from '@meebox/shared';

/** pr-agent 子命令枚举；跟 @meebox/shared 的 ReviewRunTool 同集合 */
export type PrAgentTool = 'describe' | 'review' | 'ask' | 'improve';

export interface PrAgentRunOptions {
  /**
   * pr-agent 入口 `--pr_url`。
   * - 远端模式：Bitbucket PR URL，如 https://host/projects/.../pull-requests/<id>
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
   * 本地工作树绝对路径。配置后切到 `git_provider=local` 模式：把 cwd 作为子进程
   * 工作目录，pr-agent 自己跑 `git diff <targetBranch>...HEAD`，完全不出网到代码托管。
   * 不设置则走原远端 provider 模式（默认 prUrl 远端拉 PR）。
   */
  cwd?: string;
  /**
   * 本地 diff 起点。仅 `cwd` 设置时生效；典型值是 PR base sha 或 ref 名。
   * 传给 pr-agent 的 `--target_branch`；缺省时 pr-agent 自己 fallback 到默认分支。
   */
  targetBranch?: string;
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
  /** 子进程工作目录；local 模式用 */
  cwd?: string;
  /** 用户主动取消信号；abort 后 SIGKILL 子进程并 reject reason='cancelled' */
  signal?: AbortSignal;
  /** 写入子进程 stdin 的内容（写完即 end）；chat 通道传 prompt 用。 */
  input?: string;
}

/**
 * 编排器「独立 LLM 通道」的一次原始对话调用（见 docs/arch/06-agent.md §3）。
 * 复用嵌入式运行时的 litellm（provider 路由 / 代理 / token 采集已解决）：
 * 子进程跑 `meebox_pragent_shim.chat`，prompt 经 stdin 传入，结果走 stdout，
 * token 用量经 `@@MEEBOX_USAGE@@` 哨兵打到 stderr（与 pr-agent run 同一套）。
 */
export interface ChatRunOptions {
  /** system 段（可空）。 */
  system?: string;
  /** user 段（必填）。 */
  user: string;
  /** 采样温度；anthropic 经 shim 自动剔除。 */
  temperature?: number;
  /** 注入子进程的 env（LLM key / model / 代理，复用 buildPragentEnv）。 */
  env?: Record<string, string>;
  /** 子进程工作目录；建议传中性临时目录（cli 模式避免吃到被评审仓库的 CLAUDE.md）。 */
  cwd?: string;
  timeoutMs?: number;
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
  /** 探测时拿到的版本字符串（CLI --help / --version 首行，或嵌入式查出的 pr-agent 版本） */
  readonly version: string;
  /** 跑 /describe；等价 run({ ...opts, tool: 'describe' }) */
  describe(opts: Omit<PrAgentRunOptions, 'tool'>): Promise<PrAgentRunResult>;
  /** 跑 /review；等价 run({ ...opts, tool: 'review' }) */
  review(opts: Omit<PrAgentRunOptions, 'tool'>): Promise<PrAgentRunResult>;
  /** 通用入口；后续加 /ask /improve 时直接用 run */
  run(opts: PrAgentRunOptions): Promise<PrAgentRunResult>;
  /**
   * 编排器的独立 LLM 对话通道（复用嵌入式 litellm，见 ChatRunOptions）。
   * 仅嵌入式策略支持；local-cli 策略调用即抛错。结果 stdout = 回复文本，
   * stderr 含 `@@MEEBOX_USAGE@@` token 哨兵（调用方按既有解析器累加）。
   */
  chat(opts: ChatRunOptions): Promise<PrAgentRunResult>;
}
