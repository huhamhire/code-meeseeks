import type { PrAgentStrategy } from '@pr-pilot/shared';
import { defaultExec } from './exec.js';
import type {
  ExecFn,
  PrAgentBridge,
  PrAgentRunOptions,
  PrAgentRunResult,
} from './types.js';

// 10 min — /review 在长 PR + 推理型模型 (DeepSeek-v4 / Claude thinking) 下常跑
// 3-8 min；5 min 经常打 timeout。设到 10 min 让绝大多数真实 PR 能跑完，仍能兜住
// 卡死的子进程不让它无限挂着。需要更长的话调用方可在 opts.timeoutMs 显式覆盖
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * pr-agent 官方 Docker 镜像名 + 锁定版本。Pinned tag 而非 latest，避免上游打新
 * 镜像后行为漂移（输出格式变 → findings 解析爆掉）；升级需走 PR + 单测验证。
 */
const DEFAULT_DOCKER_IMAGE_NAME = 'pragent/pr-agent';
const DEFAULT_DOCKER_IMAGE_TAG = '0.36.0';
const DEFAULT_DOCKER_IMAGE = `${DEFAULT_DOCKER_IMAGE_NAME}:${DEFAULT_DOCKER_IMAGE_TAG}`;

/** LocalCli + Docker 共享的骨架：把 RunOptions 翻成 (cmd, args, env) 后委派给 ExecFn */
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

  protected abstract buildInvocation(opts: PrAgentRunOptions): {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
  };
}

/**
 * Windows 上把绝对路径翻成 Docker Desktop 接受的 -v 源端格式：
 *   D:\foo\bar  →  /d/foo/bar
 * macOS / Linux 直接返回原路径。Docker Desktop for Mac/Windows 都接受这种 POSIX 风格。
 */
function toDockerVolumePath(abs: string): string {
  if (process.platform !== 'win32') return abs;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(abs);
  if (!m) return abs;
  return `/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}`;
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
      // 所以这里把 opts.targetBranch (= materializeWorktree 建好的 pr-pilot/base)
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
}

/**
 * 走 docker run，把 pr-agent 装在容器里跑。
 * 命令形态：`docker run --rm [-e KEY=VAL ...] <image> --pr_url <url> <tool> [extra...]`
 * env 必须以 `-e` 注入容器；spawn 自己的 env 留空（容器看不到宿主 env）。
 */
export class DockerBridge extends BaseBridge {
  readonly strategy = 'docker' as const;

  constructor(
    version: string,
    exec: ExecFn = defaultExec,
    private readonly image: string = DEFAULT_DOCKER_IMAGE,
  ) {
    super(version, exec);
  }

  protected buildInvocation(opts: PrAgentRunOptions): {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
  } {
    // 本地模式：挂载 worktree + 切 local provider，完全不出网到代码托管。
    //
    // 挂载点选 /workspace 而**不是** /app：pragent/pr-agent 社区镜像 Dockerfile 设
    // `WORKDIR /app` + 把源码装在 `/app/pr_agent/`，挂用户 worktree 到 /app 会盖掉
    // 容器自身代码。
    //
    // `-w /workspace` 必须：pr-agent LocalGitProvider 走 `_find_repository_root()`
    // 从当前工作目录往上找 `.git`，不会读 --pr_url 当路径。容器默认 cwd (/app) 没
    // .git → ValueError("Could not find repository root")。
    //
    // `--entrypoint python` + 绝对路径 `/app/pr_agent/cli.py` 必须：镜像 ENTRYPOINT
    // 是 `["python", "pr_agent/cli.py"]` ——相对路径，依赖 WORKDIR=/app。改 -w 后
    // 这条相对路径就指向 /workspace/pr_agent/cli.py 不存在了。覆盖 entrypoint 走
    // 绝对路径，cwd=/workspace + Python 找得到 cli.py 两个需求同时满足。
    //
    // **--pr_url 的值 = target branch name (不是 URL / 路径)**：local provider 把
    // --pr_url 当 LocalGitProvider 第一个位置参数 target_branch_name 用。仓库根
    // 靠容器 cwd 决定，target 分支靠 --pr_url。
    if (opts.cwd) {
      const env: Record<string, string> = {
        ...(opts.env ?? {}),
        CONFIG__GIT_PROVIDER: 'local',
      };
      const envArgs: string[] = [];
      for (const [k, v] of Object.entries(env)) {
        envArgs.push('-e', `${k}=${v}`);
      }
      const mountSrc = toDockerVolumePath(opts.cwd);
      // 额外挂载 (如空 .secrets.toml 抑制告警)。每条加一对 -v 参数
      const extraMountArgs: string[] = [];
      for (const v of opts.dockerExtraVolumes ?? []) {
        const src = toDockerVolumePath(v.host);
        extraMountArgs.push('-v', `${src}:${v.container}${v.readonly ? ':ro' : ''}`);
      }
      return {
        cmd: 'docker',
        args: [
          'run',
          '--rm',
          ...envArgs,
          '-v',
          `${mountSrc}:/workspace`,
          ...extraMountArgs,
          '-w',
          '/workspace',
          '--entrypoint',
          'python',
          this.image,
          '/app/pr_agent/cli.py',
          '--pr_url',
          opts.targetBranch ?? '',
          opts.tool,
          ...(opts.extraArgs ?? []),
        ],
        // 不向 docker 自身传 env（用户 token 应只进容器，不污染 docker daemon 调用）
      };
    }

    // 远端模式 (existing)
    const envArgs: string[] = [];
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        envArgs.push('-e', `${k}=${v}`);
      }
    }
    return {
      cmd: 'docker',
      args: [
        'run',
        '--rm',
        ...envArgs,
        this.image,
        '--pr_url',
        opts.prUrl,
        opts.tool,
        ...(opts.extraArgs ?? []),
      ],
    };
  }
}
