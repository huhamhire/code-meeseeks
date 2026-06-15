import type { PrAgentStrategy } from '@meebox/shared';
import { defaultExec } from './exec.js';
import { PrAgentRunError } from './types.js';
import type {
  ChatRunOptions,
  ExecFn,
  PrAgentBridge,
  PrAgentRunOptions,
  PrAgentRunResult,
} from './types.js';

// 10 min — /review 在长 PR + 推理型模型 (DeepSeek-v4 / Claude thinking) 下常跑
// 3-8 min；5 min 经常打 timeout。设到 10 min 让绝大多数真实 PR 能跑完，仍能兜住
// 卡死的子进程不让它无限挂着。需要更长的话调用方可在 opts.timeoutMs 显式覆盖
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
// chat 通道单次默认 5 min：编排 / 判定调用通常远快于 /review，但推理型模型仍可能慢。
const DEFAULT_CHAT_TIMEOUT_MS = 5 * 60 * 1000;
// 强制 UTF-8（中文 Windows 默认码页会让含 emoji 的输出崩，见 buildInvocation）。
const UTF8_ENV = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } as const;

/** 各策略共享的骨架：把 RunOptions 翻成 (cmd, args, env) 后委派给 ExecFn */
abstract class BaseBridge implements PrAgentBridge {
  abstract readonly strategy: PrAgentStrategy;

  constructor(
    public readonly version: string,
    protected readonly exec: ExecFn = defaultExec,
  ) {}

  describe(opts: Omit<PrAgentRunOptions, 'tool'>): Promise<PrAgentRunResult> {
    return this.run({ ...opts, tool: 'describe' });
  }

  review(opts: Omit<PrAgentRunOptions, 'tool'>): Promise<PrAgentRunResult> {
    return this.run({ ...opts, tool: 'review' });
  }

  async run(opts: PrAgentRunOptions): Promise<PrAgentRunResult> {
    const { cmd, args, env, cwd } = this.buildInvocation(opts);
    return this.exec(cmd, args, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env,
      onLine: opts.onLine,
      cwd,
      signal: opts.signal,
    });
  }

  async chat(opts: ChatRunOptions): Promise<PrAgentRunResult> {
    const { cmd, args, env, cwd } = this.buildChatInvocation(opts);
    const input = JSON.stringify({
      system: opts.system ?? '',
      user: opts.user,
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    });
    return this.exec(cmd, args, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS,
      env,
      cwd,
      input,
      signal: opts.signal,
    });
  }

  protected abstract buildInvocation(opts: PrAgentRunOptions): {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
  };

  /** chat 通道的 (cmd, args, env, cwd)；仅嵌入式支持，其余策略抛错。 */
  protected abstract buildChatInvocation(opts: ChatRunOptions): {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
  };
}

/**
 * 走系统 PATH 的 pr-agent CLI（pipx / pip / brew 安装）。
 *
 * 远端模式 (opts.cwd 未配置)：`pr-agent --pr_url <url> <tool>`
 * 本地模式 (opts.cwd 已配置)：子进程 cwd 落到 worktree；env 注入
 *   `CONFIG__GIT_PROVIDER=local`，命令变为
 *   `pr-agent --pr_url <cwd> [--target_branch <base>] <tool>`
 */
export class LocalCliBridge extends BaseBridge {
  readonly strategy = 'local-cli' as const;

  protected buildInvocation(opts: PrAgentRunOptions): {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
  } {
    if (opts.cwd) {
      // 反直觉但是 pr-agent 社区版 LocalGitProvider 的真实行为：
      // get_git_provider_with_context 把 --pr_url 的值作为第一个位置参数传给
      // LocalGitProvider(target_branch_name)，**--pr_url 在 local 模式下就是
      // target branch 的名字**，不是 PR URL 或路径。仓库根靠容器 cwd 自己走 .git
      // 父目录查找定位，跟 --pr_url 无关。
      // 所以这里把 opts.targetBranch (= materializeWorktree 建好的 meebox/base)
      // 直接填到 --pr_url 槽位。
      return {
        cmd: 'pr-agent',
        args: [
          '--pr_url',
          opts.targetBranch ?? '',
          opts.tool,
          ...(opts.extraArgs ?? []),
        ],
        env: { ...(opts.env ?? {}), CONFIG__GIT_PROVIDER: 'local' },
        cwd: opts.cwd,
      };
    }
    return {
      cmd: 'pr-agent',
      args: ['--pr_url', opts.prUrl, opts.tool, ...(opts.extraArgs ?? [])],
      env: opts.env,
    };
  }

  protected buildChatInvocation(): {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
  } {
    throw new PrAgentRunError(
      'chat 通道仅支持嵌入式运行时（local-cli 策略无 meebox 运行时）',
      'spawn-failed',
    );
  }
}

/**
 * 走随 app 打包的嵌入式 Python 运行时：用 `<vendor>/python -m
 * pr_agent.cli` 跑 pr-agent，免除用户预装 Python / Docker。
 *
 * 形态与 LocalCli 的 local 模式一致（local provider，cwd=worktree，
 * CONFIG__GIT_PROVIDER=local），区别仅在 cmd 指向嵌入式解释器绝对路径 +
 * `-m pr_agent.cli`。嵌入式运行时只用于本地 worktree，所以 cwd 恒被设置；
 * 万一未设也兜底走远端 `--pr_url <prUrl>`（与 LocalCli 对齐）。
 */
export class EmbeddedRuntimeBridge extends BaseBridge {
  readonly strategy = 'embedded' as const;

  constructor(
    version: string,
    private readonly pythonPath: string,
    exec: ExecFn = defaultExec,
  ) {
    super(version, exec);
  }

  protected buildInvocation(opts: PrAgentRunOptions): {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
  } {
    const cli = ['-m', 'pr_agent.cli'];
    // 强制 UTF-8 模式：嵌入式 Python 在中文 Windows 上默认用系统码页 (GBK/cp936) 做
    // stdio / 文件编码，pr-agent 输出含 emoji (如 🔍 section 标题) 时会 'gbk' codec
    // can't encode 崩掉。PYTHONUTF8=1 覆盖 stdio+fs+默认 open() 编码，IOENCODING 兜底。
    const utf8 = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    if (opts.cwd) {
      return {
        cmd: this.pythonPath,
        args: [...cli, '--pr_url', opts.targetBranch ?? '', opts.tool, ...(opts.extraArgs ?? [])],
        env: { ...(opts.env ?? {}), ...utf8, CONFIG__GIT_PROVIDER: 'local' },
        cwd: opts.cwd,
      };
    }
    return {
      cmd: this.pythonPath,
      args: [...cli, '--pr_url', opts.prUrl, opts.tool, ...(opts.extraArgs ?? [])],
      env: { ...(opts.env ?? {}), ...utf8 },
    };
  }

  protected buildChatInvocation(opts: ChatRunOptions): {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
  } {
    // 跑随运行时打包的 chat helper：复用 pr-agent 已被 shim 补丁的 LiteLLMAIHandler
    // （provider 路由 / CLI 模式 / 去 temperature / usage 哨兵全继承）。
    return {
      cmd: this.pythonPath,
      args: ['-m', 'meebox_pragent_shim.chat'],
      env: { ...(opts.env ?? {}), ...UTF8_ENV },
      cwd: opts.cwd,
    };
  }
}
