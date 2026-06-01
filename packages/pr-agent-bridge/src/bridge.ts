import type { PrAgentStrategy } from '@pr-pilot/shared';
import { defaultExec } from './exec.js';
import type {
  ExecFn,
  PrAgentBridge,
  PrAgentRunOptions,
  PrAgentRunResult,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — pr-agent /review 较慢的复杂 PR

/**
 * pr-agent 官方 Docker 镜像名 + 锁定版本。Pinned tag 而非 latest，避免上游打新
 * 镜像后行为漂移（输出格式变 → findings 解析爆掉）；升级需走 PR + 单测验证。
 */
const DEFAULT_DOCKER_IMAGE_NAME = 'pragent/pr-agent';
const DEFAULT_DOCKER_IMAGE_TAG = '0.35.0';
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
    const { cmd, args, env } = this.buildInvocation(opts);
    return this.exec(cmd, args, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env,
      onLine: opts.onLine,
    });
  }

  protected abstract buildInvocation(opts: PrAgentRunOptions): {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
  };
}

/**
 * 走系统 PATH 的 pr-agent CLI（pipx / pip / brew 安装）。
 * 命令形态：`pr-agent --pr_url <url> <tool> [extra...]`
 * env 直接通过子进程继承（exec 层负责 merge process.env）。
 */
export class LocalCliBridge extends BaseBridge {
  readonly strategy = 'local-cli' as const;

  protected buildInvocation(opts: PrAgentRunOptions): {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
  } {
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
  } {
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
      // 不向 docker 自身传 env（用户 token 应只进容器，不污染 docker daemon 调用）
    };
  }
}
