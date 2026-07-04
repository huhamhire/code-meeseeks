import type { PrAgentStrategy } from '@meebox/shared';
import { DEFAULT_CHAT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, UTF8_ENV } from './constants.js';
import { defaultExec } from './exec.js';
import { PrAgentRunError } from './types.js';
import type {
  ChatRunOptions,
  ExecFn,
  PrAgentBridge,
  PrAgentRunOptions,
  PrAgentRunResult,
} from './types.js';

/** Skeleton shared by all strategies: translate RunOptions into (cmd, args, env) then delegate to ExecFn */
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
      ...(opts.maxOutputTokens != null ? { max_output_tokens: opts.maxOutputTokens } : {}),
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

  /** (cmd, args, env, cwd) for the chat channel; only the embedded strategy supports it, others throw. */
  protected abstract buildChatInvocation(opts: ChatRunOptions): {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
  };
}

/**
 * pr-agent CLI on the system PATH (installed via pipx / pip / brew).
 *
 * Remote mode (opts.cwd not set): `pr-agent --pr_url <url> <tool>`
 * Local mode (opts.cwd set): subprocess cwd points at the worktree; env injects
 *   `CONFIG__GIT_PROVIDER=local`, the command becomes
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
      // Counterintuitive but the real behavior of the pr-agent community edition LocalGitProvider:
      // get_git_provider_with_context passes the --pr_url value as the first positional argument to
      // LocalGitProvider(target_branch_name), so **in local mode --pr_url is the name of the
      // target branch**, not a PR URL or path. The repo root is located by the container cwd itself
      // walking up parent directories looking for .git, unrelated to --pr_url.
      // So here we put opts.targetBranch (= the pr-<localId>/base built by materializeWorktree)
      // directly into the --pr_url slot.
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
 * Uses the embedded Python runtime bundled with the app: runs pr-agent via
 * `<vendor>/python -m pr_agent.cli`, sparing the user from pre-installing Python / Docker.
 *
 * Shape is identical to LocalCli's local mode (local provider, cwd=worktree,
 * CONFIG__GIT_PROVIDER=local); the only difference is cmd points at the embedded
 * interpreter's absolute path + `-m pr_agent.cli`. The embedded runtime is only used for
 * local worktrees, so cwd is always set; should it be unset, it falls back to remote
 * `--pr_url <prUrl>` (aligned with LocalCli).
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
    // Force UTF-8 (UTF8_ENV): on Chinese Windows the embedded Python defaults to the system code page, which crashes output containing emoji, see constants.
    if (opts.cwd) {
      return {
        cmd: this.pythonPath,
        args: [...cli, '--pr_url', opts.targetBranch ?? '', opts.tool, ...(opts.extraArgs ?? [])],
        env: { ...(opts.env ?? {}), ...UTF8_ENV, CONFIG__GIT_PROVIDER: 'local' },
        cwd: opts.cwd,
      };
    }
    return {
      cmd: this.pythonPath,
      args: [...cli, '--pr_url', opts.prUrl, opts.tool, ...(opts.extraArgs ?? [])],
      env: { ...(opts.env ?? {}), ...UTF8_ENV },
    };
  }

  protected buildChatInvocation(opts: ChatRunOptions): {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
  } {
    // Runs the chat helper bundled with the runtime: in API mode it reuses pr-agent's shim-patched
    // LiteLLMAIHandler (inheriting provider routing / temperature removal / prompt cache / usage sentinel);
    // in CLI mode (MEEBOX_CLI_MODE) the helper calls the local CLI directly, without importing
    // pr_agent / litellm, saving the import cost on every startup.
    return {
      cmd: this.pythonPath,
      args: ['-m', 'meebox_pragent_shim.chat'],
      env: { ...(opts.env ?? {}), ...UTF8_ENV },
      cwd: opts.cwd,
    };
  }
}
