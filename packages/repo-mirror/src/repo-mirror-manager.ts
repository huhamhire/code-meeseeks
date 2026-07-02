import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import simpleGit, { type SimpleGit } from 'simple-git';
import type { Logger } from 'pino';
import type { SyncProgressEvent } from '@meebox/shared';
import type {
  BlameLine,
  ChangedFile,
  ChangedFileStatus,
  FileContent,
  MirrorResult,
  RepoIdentity,
  RepoSize,
} from './types.js';

/**
 * simple-git 的 blockUnsafeOperationsPlugin 会扫描传给 `.env()` 的 env 对象，命中这批
 * "危险" key（小写匹配）就抛 `Use of "X" is not permitted without enabling allowUnsafeXxx`。
 * 列表对齐 simple-git v3 env policy。宿主常见的 EDITOR / PAGER / SSH_ASKPASS / PREFIX 都在内。
 *
 * 我们给远端 git 挂代理时必须 merge process.env（否则 PATH/HOME 全丢），但 merge 会把这些
 * 宿主变量带进 .env() 触发校验。对无人值守的 clone/fetch 这些（编辑器/pager/askpass/外部
 * config 路径等）一律用不到，merge 时统一剔除，比逐个开 allowUnsafe 标志更稳更全。
 */
const GIT_UNSAFE_ENV_KEYS = new Set([
  'editor',
  'git_editor',
  'git_sequence_editor',
  'pager',
  'git_pager',
  'git_askpass',
  'ssh_askpass',
  'git_ssh',
  'git_ssh_command',
  'git_proxy_command',
  'git_external_diff',
  'git_template_dir',
  'git_exec_path',
  'git_config',
  'git_config_global',
  'git_config_system',
  'git_config_count',
  'prefix',
]);

/** Promise 版 execFile：用于 simple-git 会因非零退出吞掉 stdout 的命令（如 merge-tree 冲突时退出码 1）。 */
const execFileAsync = promisify(execFile);

/** 从 env 里剔除 simple-git 会拦的危险 key（大小写不敏感）。 */
function stripGitUnsafeEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!GIT_UNSAFE_ENV_KEYS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

export interface RepoMirrorOptions {
  /** repos_dir 根（来自 config.workspace.repos_dir，已展开 ~） */
  reposDir: string;
  /** 由 PlatformAdapter 提供：给一个 repo 返回带认证的 clone URL */
  getCloneUrl: (repo: RepoIdentity) => Promise<string>;
  logger?: Logger;
  /** 可选 sync 进度回调；clone/fetch 期间分阶段发出 start/progress/done/error */
  onProgress?: (event: SyncProgressEvent) => void;
  /**
   * 可选出站代理 env。getter 形式，每次远端 clone/fetch 前求值，
   * 让设置页改代理后下次操作即生效。返回 HTTP(S)_PROXY/NO_PROXY 等；关闭时返回 {}。
   * 仅作用于打远端的 clone/fetch；本地只读 git 操作不注入。
   */
  proxyEnv?: () => Record<string, string>;
}

/**
 * 本地 git 镜像管理。**全局** sync 队列：任意时刻只有 1 个 repo 在 clone/fetch。
 * 多个调用方 (UI 切 PR / 主进程 schedule) 都共用此队列，不并发打 Bitbucket、不抢
 * git 进程带宽，用户感知到的进度更稳。
 *
 * 读操作 (listChangedFiles / getFileContent / getSize) 不走队列，对本地 bare
 * 镜像并发只读安全。
 *
 * 策略：`git clone --bare`（完整 bare 镜像，含全部 blobs）。早期用过
 * `--filter=blob:none` partial clone 省盘，但 `git blame --porcelain` 会触发
 * 全量历史 blob 的按需拉取；M2-D 实测下来要么慢、要么远端不全时直接 fatal
 * 退出。为换取 blame / pr-agent 这类需要历史 blob 的工具能稳定跑，改回完整
 * bare clone，磁盘占用代价交给用户在设置页可见的总占用 + 可换 `repos_dir`。
 *
 * 后续 fetch 走 `git fetch`，增量。
 *
 * 不做 worktree。M2 范围内 diff 计算走 `git show <sha>:<path>`，不需要把
 * 文件 checkout 到磁盘。M3 接 pr-agent 时再看是否需要 worktree。
 */
export class RepoMirrorManager {
  /** 全局单队列指针；每次新 syncMirror 都接到它的尾部，串行执行。 */
  private syncQueue: Promise<unknown> = Promise.resolve();
  /** 按 repoKey 索引正在跑（或排队）的 sync Promise；同 repo 并发调用复用。 */
  private readonly inFlight = new Map<string, Promise<MirrorResult>>();

  constructor(private readonly opts: RepoMirrorOptions) {}

  /**
   * 给打远端的 simple-git 实例挂代理 env。代理关闭 / 未配置时原样返回
   * （git 子进程继承 process.env）。注意 simple-git 的 .env() 整体替换子进程 env，
   * 故必须 merge process.env，否则 PATH / HOME 等全丢。
   */
  private withProxyEnv(git: SimpleGit): SimpleGit {
    const px = this.opts.proxyEnv?.() ?? {};
    if (Object.keys(px).length === 0) return git;
    // 剔除宿主 EDITOR/PAGER/SSH_ASKPASS 等：simple-git 的安全插件会拦截传给 .env() 的
    // 这些 key 并抛 allowUnsafeEditor 等错误（见 GIT_UNSAFE_ENV_KEYS 注释）。
    const merged = stripGitUnsafeEnv({ ...process.env, ...px } as Record<string, string>);
    return git.env(merged);
  }

  /** 计算 bare 镜像应当落在哪里（不保证存在）。 */
  mirrorPath(repo: RepoIdentity): string {
    return path.join(this.opts.reposDir, repo.host, repo.projectKey, repo.repoSlug, 'bare');
  }

  /**
   * 检查指定 commit sha 在本地 bare 镜像里是否可达。用于"打开 PR 时若本地已经
   * 包含 head + base sha 就跳过 fetch"的预检 (省一趟网络往返)。
   *
   * 实现：`git cat-file -e <sha>^{commit}` —— 只验证存在性且确实是 commit
   * 类型 (不是 tree/blob)，命中 exit 0、缺失 exit 非 0。比 `rev-parse` 更轻
   * (不解析 reflog / refs)，比 `log -1` 更精确 (后者部分远端不全的对象也能"看见")。
   *
   * 镜像目录不存在 → 直接 false (尚未 clone)。git 错误 → 视为 false (保守)。
   */
  async hasCommit(repo: RepoIdentity, sha: string): Promise<boolean> {
    if (!sha) return false;
    const mp = this.mirrorPath(repo);
    try {
      await fs.access(mp);
    } catch {
      return false;
    }
    try {
      await simpleGit(mp).raw(['cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 按给定 refspec best-effort fetch 进 bare 镜像（典型用法：补一道平台 PR 头引用
   * `refs/pull/<n>/head` 等，把被删 / 强推源分支的 PR head sha 钉回本地——`refs/heads/*` 已看不到它）。
   * 镜像不存在 / fetch 失败均**不抛**（网络 / 远端拒绝 / 该 PR 引用不存在都可能），调用方随后自行复验
   * hasCommit。空 refspec 直接返回。前置：调用方已 await 过 syncMirror，故与全局 sync 队列无并发。
   */
  async fetchRefspecs(repo: RepoIdentity, refspecs: string[]): Promise<void> {
    if (refspecs.length === 0) return;
    const mp = this.mirrorPath(repo);
    try {
      await fs.access(mp);
    } catch {
      return;
    }
    try {
      await this.withProxyEnv(simpleGit({ baseDir: mp })).raw(['fetch', 'origin', ...refspecs]);
    } catch (err) {
      this.opts.logger?.debug(
        {
          err: err instanceof Error ? err.message : String(err),
          repo: this.repoKey(repo),
          refspecs,
        },
        'fetchRefspecs failed (best-effort); sha may still be unreachable',
      );
    }
  }

  /**
   * 镜像是否「健康」：是有效 git 目录且 origin remote 已配置。clone/fetch 中途被打断会留下「HEAD 在、
   * 但 git 元数据残缺（常缺 origin remote）」的目录，仅判 HEAD 存在会误以为可 fetch → `git fetch origin`
   * 直接 fatal（`'origin' does not appear to be a git repository`）。用 `git config --get
   * remote.origin.url` 同时验证两点：命令在非 git 目录会失败，origin 未配置则无输出 → 任一不满足即不健康，
   * 调用方据此删库重建（见 doSyncMirror 的主动自愈）。
   */
  private async isHealthyMirror(mirrorPath: string): Promise<boolean> {
    try {
      const url = await simpleGit(mirrorPath).raw(['config', '--get', 'remote.origin.url']);
      return url.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * 计算 base..head 之间「源分支主干自产」的 commit 数 (PR 引入的提交数)。完全走本地 bare 镜像
   * `git rev-list --count --first-parent --no-merges <base>..<head>` —— 不打远端，毫秒级返回。
   *
   * 用途：UI 在 PR 标签页上展示 commits 数角标，不必为了一个数字去拉远端。base 传**分叉点 sha**
   * （merge-base）时 base..head = 源分支自分叉后引入的提交；`--first-parent` 只沿源分支主干，把
   * 历史上 merge 其它分支带进来的他人提交一并排除，`--no-merges` 再略去 merge 提交本身——口径
   * 与 {@link listIntroducedCommitShas}（commit 列表 / 活动时间线的过滤集）一致，避免角标与列表对不上。
   *
   * 任一 sha 不在本地镜像 (尚未 sync 到本 PR 范围) → 返回 null，调用方把它
   * 当 "暂时未知" 处理 (不显示角标 / 显示加载占位)。
   */
  async countCommits(repo: RepoIdentity, baseSha: string, headSha: string): Promise<number | null> {
    const shas = await this.listIntroducedCommitShas(repo, baseSha, headSha);
    return shas === null ? null : shas.length;
  }

  /**
   * 列出 base..head 之间「源分支主干自产」的提交 SHA（40-char），newest-first。完全走本地 bare
   * 镜像 `git rev-list --first-parent --no-merges <base>..<head>` —— 不打远端。
   *
   * `--first-parent` 只沿源分支主干遍历：历史上把别的分支 merge 进源分支带来的**他人提交**（落在
   * merge 提交的第二父侧）不会进入结果；`--no-merges` 再剔除 merge 提交本身。最终只剩源分支上直接
   * 产出的提交。
   *
   * 用途：把平台 `/commits` 端点返回的完整列表（`target..source` 全集，含 merge 及合入的他人提交）
   * 过滤为「本 PR 真正引入的提交」，消除长期分支 / fork 同步分支反复 merge 造成的列表噪声。
   *
   * 任一 sha 不在本地镜像（尚未 sync 到本 PR 范围）→ 返回 null，调用方退回未过滤的平台列表。
   */
  async listIntroducedCommitShas(
    repo: RepoIdentity,
    baseSha: string,
    headSha: string,
  ): Promise<string[] | null> {
    if (!baseSha || !headSha) return null;
    const [hasBase, hasHead] = await Promise.all([
      this.hasCommit(repo, baseSha),
      this.hasCommit(repo, headSha),
    ]);
    if (!hasBase || !hasHead) return null;
    const mp = this.mirrorPath(repo);
    try {
      const out = await simpleGit(mp).raw([
        'rev-list',
        '--first-parent',
        '--no-merges',
        `${baseSha}..${headSha}`,
      ]);
      return out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } catch {
      return null;
    }
  }

  /**
   * `git merge-base a b` —— 两 sha 的最近共同祖先（PR 源分支自目标分叉处）。
   * 用于把 PR diff 的 base 锚到分叉点（而非随别的 PR 合入而前移的目标分支 tip）。
   * 任一 sha 缺失 / 无共同祖先 / 缺对象 → 返回 null，调用方兜底（不固化、下次再试）。
   */
  async mergeBase(repo: RepoIdentity, a: string, b: string): Promise<string | null> {
    if (!a || !b) return null;
    const mp = this.mirrorPath(repo);
    try {
      const out = await simpleGit(mp).raw(['merge-base', a, b]);
      const sha = out.trim();
      return sha || null;
    } catch {
      return null;
    }
  }

  /**
   * `git merge-base --is-ancestor anc desc` —— anc 是否为 desc 的祖先。
   * 用于校验固化的 base 对当前 head 仍有效（head 正常 push 仍成立；被 rebase 则不成立 → 触发重算）。
   * exit 0 → true；exit 1（非祖先）/ 缺对象 → false。
   */
  async isAncestor(repo: RepoIdentity, anc: string, desc: string): Promise<boolean> {
    if (!anc || !desc) return false;
    const mp = this.mirrorPath(repo);
    try {
      await simpleGit(mp).raw(['merge-base', '--is-ancestor', anc, desc]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 同步镜像：首次 clone bare partial，后续 fetch。
   *
   * 调度规则：
   * - 同 repo 并发调用 → 复用同一 in-flight Promise（不重复 sync，进度共享）
   * - 不同 repo 串行：所有新 sync 都接到全局队列尾部，任意时刻最多 1 个在跑
   *
   * 进度通过 onProgress 回调对外发出；多个调用方共用同一 sync 时各自的
   * 订阅者都会收到同一组事件。
   */
  async syncMirror(repo: RepoIdentity): Promise<MirrorResult> {
    const key = this.repoKey(repo);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const run = (): Promise<MirrorResult> => this.doSyncMirror(repo);
    // 不论 prev 成败都执行 run，避免某次失败堵塞后续整条队列
    const promise = this.syncQueue.then(run, run);
    this.inFlight.set(key, promise);
    // 队列尾指针推到 next（用 catch 把失败摊平为 undefined，确保下一个 .then
    // 的 onFulfilled 被调用）；await 的仍然是原 promise，拿到真实结果/异常
    this.syncQueue = promise.catch(() => undefined);

    // sync 完成 / 失败后从 in-flight 移除，下次调用可启新的 sync。
    // 先 catch 吃掉 rejection（避免 finally 链上抛 unhandled rejection），
    // 调用方 await 原 promise 仍能拿到真实的 reject。
    promise
      .catch(() => undefined)
      .finally(() => {
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
        }
      });

    return promise;
  }

  /**
   * 从 bare mirror 派生一个**自含**的临时工作树，HEAD 在命名分支 `pr-<localId>/head`
   * 上指向 headSha；可选再建个 `pr-<localId>/base` 指向 baseSha。
   *
   * 为什么需要这样：pr-agent 社区版 `LocalGitProvider.__init__` 做两件强约束的事：
   *   - `self.head_branch_name = self.repo.head.ref.name` —— HEAD 必须在命名分支
   *     上（不能 detached），否则 GitPython 抛 TypeError
   *   - `LOCAL__TARGET_BRANCH` 必须是 `self.repo.heads` 里存在的**分支名**
   *     （不接受 sha），否则 `branches[target_name]` KeyError
   * 分支名用 `pr-<localId>/<head|base>`（localId = 每-PR 稳定主键）：与 PR 关联便于追溯，
   * 又避开跟仓库真实分支的冲突；不带工具品牌前缀，不留固定可辨识特征。未提供 localId
   * （包级直调）时回退到本次随机 nonce，保持每次不同。
   *
   * 为什么不用 `git worktree add`：worktree 的 `.git` 是个 file，内容是
   *   `gitdir: <bare-host-path>/worktrees/<name>`
   * 依赖一个外部 host 绝对路径，bare 仓库移动 / 清理后顺链断裂，GitPython 找不到
   * git dir → 抛 `Could not find repository root`。
   *
   * 实现：`git clone --local --no-checkout` 从 bare 派生独立 repo —— 同盘时
   * objects 走 hardlinks，磁盘 ~0；.git 自含、不依赖外部路径，更稳。再 fetch
   * 一道 Bitbucket 专有的 refspec `refs/pull-requests/<id>/from` 把 PR 源 sha 拉齐 (默认
   * refspec 不拉它，否则 PR 源分支被删 / 强推后 checkout 会失败)。
   *
   * 返回 `{ path, headBranchName, targetBranchName?, cleanup }`：
   *   - `headBranchName`：HEAD 当前在的分支名（`pr-<localId>/head`），调用方一般
   *     用不上但留作接口对称
   *   - `targetBranchName`：baseSha 传了才有，pr-agent `LOCAL__TARGET_BRANCH` 填它
   *   - `cleanup()`：清理临时目录
   *
   * 命名：`<reposDir>/<repo>/wt/<sha12>-<ts>-<rand>`，并发安全靠时间戳 + 随机后缀。
   */
  async materializeWorktree(
    repo: RepoIdentity,
    headSha: string,
    baseSha?: string,
    prLocalId?: string,
  ): Promise<{
    path: string;
    headBranchName: string;
    targetBranchName?: string;
    cleanup: () => Promise<void>;
  }> {
    const mirrorPath = this.mirrorPath(repo);
    const wtRoot = path.join(this.opts.reposDir, repo.host, repo.projectKey, repo.repoSlug, 'wt');
    await fs.mkdir(wtRoot, { recursive: true });
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const wtPath = path.join(wtRoot, `${headSha.slice(0, 12)}-${nonce}`);

    // 分支名与 PR 关联（localId = 每-PR 稳定主键）便于追溯，不带工具品牌前缀；无 localId
    // （包级直调）时回退到本次随机 nonce。用 `<ns>/head`、`<ns>/base` 分层命名（贴合平台
    // PR ref 惯例如 refs/pull/N/head）；不单独建裸 `<ns>` 分支，故无 git dir/file ref 冲突。
    const branchNs = prLocalId ? `pr-${prLocalId}` : `pr-${nonce}`;
    const HEAD_BRANCH = `${branchNs}/head`;
    const BASE_BRANCH = `${branchNs}/base`;

    // --local + 默认 hardlinks：同盘 inode 共享，无 alternates 文件 (避免跨 mount 断链)
    // --no-checkout：先不落文件，等分支建好再 checkout
    await simpleGit(wtRoot).clone(mirrorPath, wtPath, ['--local', '--no-checkout']);

    // 禁用 LFS smudge filter：bare mirror 默认不拉 LFS 对象 (--mirror 仅拉 git refs)，
    // 容器也通常打不到企业内网的 LFS server。让 LFS pointer 保持原样 (几百字节的
    // pointer 文本)，否则 `git checkout` 会调 git-lfs 去远端拉真实 blob，smudge 失败
    // → exit。pr-agent review 二进制文件无意义，看到 pointer 文本只是小段元数据。
    //   - filter.lfs.smudge=cat：smudge 时直接 cat 文件 (不调 git-lfs)
    //   - filter.lfs.process=空：清空 long-lived filter process (默认 git-lfs filter-process)
    //   - filter.lfs.required=false：filter 不存在 / 失败不当致命错误
    // 配置在 .git/config 持久化，pr-agent 容器内继承同一 config，自然也不触发 LFS。
    //
    // simple-git 默认禁止设 filter.* (担心被注入任意命令)；显式 allowUnsafeFilter
    // 仅在这个 simpleGit 实例上 opt-in，其他读操作走默认严格模式
    const lfsCfg = simpleGit({ baseDir: wtPath, unsafe: { allowUnsafeFilter: true } });
    await lfsCfg.raw(['config', '--local', 'filter.lfs.smudge', 'cat']);
    await lfsCfg.raw(['config', '--local', 'filter.lfs.process', '']);
    await lfsCfg.raw(['config', '--local', 'filter.lfs.required', 'false']);

    // 补 Bitbucket 的 PR 源 sha：`git clone` 默认只拉 refs/heads/*。失败不阻断
    // (heads 里能找到 headSha 也行，例如 GitHub fork)
    try {
      await simpleGit(wtPath).raw([
        'fetch',
        mirrorPath,
        '+refs/pull-requests/*/from:refs/pull-requests/*/from',
      ]);
    } catch (err) {
      this.opts.logger?.debug(
        { err, wtPath },
        'pull-requests refspec fetch failed; head may still be reachable via heads',
      );
    }

    // 建命名分支 meebox/head 指向 headSha 并 checkout (pr-agent 要求 HEAD 在命名分支上)
    await simpleGit(wtPath).raw(['checkout', '-b', HEAD_BRANCH, headSha]);

    // baseSha 提供时建 meebox/base 指向它 (pr-agent LOCAL__TARGET_BRANCH 只认分支名)
    let targetBranchName: string | undefined;
    if (baseSha) {
      await simpleGit(wtPath).raw(['branch', '-f', BASE_BRANCH, baseSha]);
      targetBranchName = BASE_BRANCH;
    }

    this.opts.logger?.debug(
      { repo: this.repoKey(repo), headSha, baseSha, wtPath, targetBranchName },
      'materialized worktree (self-contained clone)',
    );
    return {
      path: wtPath,
      headBranchName: HEAD_BRANCH,
      targetBranchName,
      cleanup: async () => {
        // 自含 clone，没有 bare 端登记需要清理，直接 rm -rf 即可
        await fs.rm(wtPath, { recursive: true, force: true }).catch((err) => {
          this.opts.logger?.warn({ err, wtPath }, 'worktree cleanup failed');
        });
      },
    };
  }

  /** 镜像大小（字节）。不存在返回 0。 */
  async getSize(repo: RepoIdentity): Promise<RepoSize> {
    const dir = this.mirrorPath(repo);
    if (!(await this.exists(dir))) return { totalBytes: 0 };
    return { totalBytes: await this.dirSize(dir) };
  }

  /**
   * 列出 PR 范围内变更文件（baseSha 与 headSha 的三点 diff，与 Bitbucket/GitHub
   * 的 PR diff 一致：head 自分叉后引入的变化）。
   *
   * 用 -z 把状态 + path NUL 分隔，路径含空格/中文 / 引号都不会破。
   */
  async listChangedFiles(
    repo: RepoIdentity,
    baseSha: string,
    headSha: string,
  ): Promise<ChangedFile[]> {
    const mirrorPath = this.mirrorPath(repo);
    // 刚 clone / fetch 完，包文件可能还在 FS flush；某些 sha 第一次 cat 时
    // git 可能短暂报 'Invalid symmetric difference' / 'bad revision'。简单重试
    // 两次，间隔 200ms / 400ms 后通常就稳了。失败再向上抛由 renderer 走 banner。
    const out = await retryTransientGit(
      () => simpleGit(mirrorPath).raw(['diff', '-z', '--name-status', `${baseSha}...${headSha}`]),
      this.opts.logger,
      { op: 'listChangedFiles', repo: this.repoKey(repo), baseSha, headSha },
    );
    return parseNameStatusZ(out);
  }

  /**
   * 列出把源 head 合并进目标 tip 会冲突的文件路径（`git merge-tree --write-tree` 的试合并，git ≥ 2.38）。
   * 无冲突（退出码 0）/ 无法判定（退出码 < 0 或 git 过旧）→ 返回空数组，由调用方保守不标记。
   *
   * merge-tree 冲突时退出码为 1 且把结果写到 stdout，simple-git 会因非零退出吞掉 stdout，故直接走
   * execFile 自行捕获 stdout。`-z` 让输出 NUL 分隔（路径含空格/中文/引号都不破），`--name-only` 只出冲突
   * 文件名：首字段是结果 tree OID，随后是各冲突文件名，遇空字段（段分隔的双 NUL）即冲突文件段结束。
   */
  async listConflictFiles(
    repo: RepoIdentity,
    targetSha: string,
    sourceSha: string,
  ): Promise<string[]> {
    if (!targetSha || !sourceSha) return [];
    const mirrorPath = this.mirrorPath(repo);
    try {
      // 退出码 0 = 干净可合并，无冲突。
      await execFileAsync(
        'git',
        ['merge-tree', '--write-tree', '--name-only', '-z', targetSha, sourceSha],
        { cwd: mirrorPath, maxBuffer: 64 * 1024 * 1024 },
      );
      return [];
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string | Buffer };
      // 退出码 1 = 存在冲突，stdout 携带冲突文件段；其余（无法完成试合并 / git 过旧）保守返回空。
      if (e.code === 1 && e.stdout != null) {
        return parseMergeTreeConflictsZ(e.stdout.toString());
      }
      this.opts.logger?.warn(
        { err, repo: this.repoKey(repo), targetSha, sourceSha },
        'git merge-tree conflict probe failed; treating as no conflict',
      );
      return [];
    }
  }

  /**
   * 读取某文件在某 commit 的内容。完整 bare clone 下 blob 都在本地，直接 git show。
   * 文件不在该 commit (新增/删除场景) 返回空 content。
   * 简单 null-byte 启发判定二进制（前 8000 字符）。
   */
  async getFileContent(repo: RepoIdentity, sha: string, filePath: string): Promise<FileContent> {
    const mirrorPath = this.mirrorPath(repo);
    let content: string;
    try {
      content = await simpleGit(mirrorPath).raw(['show', `${sha}:${filePath}`]);
    } catch {
      // 文件在该 commit 不存在（新增前 / 删除后），返回空
      return { binary: false, content: '' };
    }
    if (content.slice(0, 8000).includes(' ')) {
      return { binary: true };
    }
    return { binary: false, content };
  }

  /**
   * 列出 PR (`baseSha...headSha`) 中 head 一侧被新增 / 修改的行号集合。
   * 用于 blame 过滤：PR 自己引入的行不展示历史 blame（语义上没意义，只会指向
   * PR 自己的 commit），仅对 base 已有部分展示原始归属。
   *
   * 走 `git diff -U0 base...head -- path`，解析 hunk 头 `@@ -A,B +C,D @@` 的
   * 右侧 C..C+D-1 段。D=0（纯删除）不贡献任何 head 行。
   */
  async listChangedHeadLines(
    repo: RepoIdentity,
    baseSha: string,
    headSha: string,
    filePath: string,
  ): Promise<Set<number>> {
    const mirrorPath = this.mirrorPath(repo);
    let out: string;
    try {
      out = await simpleGit(mirrorPath).raw([
        'diff',
        '-U0',
        '--no-color',
        `${baseSha}...${headSha}`,
        '--',
        filePath,
      ]);
    } catch (err) {
      this.opts.logger?.warn(
        { err, repo: this.repoKey(repo), baseSha, headSha, filePath },
        'git diff for changed lines failed',
      );
      // 失败时保守返回空集 → blame 全部展示；至少不丢信息
      return new Set();
    }
    return parseHunkAddedLines(out);
  }

  /**
   * 跑 `git blame --porcelain <sha> -- <path>` 并解析逐行的归属 commit + 作者 + 时间。
   * 完整 bare clone 下历史 blob 都在本地，正常情况下应该秒出。
   *
   * 错误处理分两档：
   *   - **`fatal: no such path X in <sha>`**：文件在该 sha 不存在（PR 把它删了 /
   *     重命名 / 后续 commit 又改回原状）。这是合法状态，blame 自然不存在，返
   *     回空数组让 renderer "无 blame 留空" 而不是弹错误 banner。
   *   - 其它错误：抛出让 renderer 走 BackendErrorBanner，附原始 git stderr。
   */
  async getBlame(repo: RepoIdentity, sha: string, filePath: string): Promise<BlameLine[]> {
    const mirrorPath = this.mirrorPath(repo);
    try {
      const out = await simpleGit(mirrorPath).raw(['blame', '--porcelain', sha, '--', filePath]);
      return parseBlamePorcelain(out);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no such path/i.test(msg)) {
        this.opts.logger?.debug(
          { repo: this.repoKey(repo), sha, filePath },
          'git blame: path not in sha; returning empty blame',
        );
        return [];
      }
      this.opts.logger?.warn({ err, repo: this.repoKey(repo), sha, filePath }, 'git blame failed');
      throw err;
    }
  }

  private async doSyncMirror(repo: RepoIdentity): Promise<MirrorResult> {
    const mirrorPath = this.mirrorPath(repo);
    const key = this.repoKey(repo);
    let hasMirror = await this.exists(path.join(mirrorPath, 'HEAD'));
    // 自愈（主动）：目录存在但不是**健康**镜像 —— clone/fetch 中途被打断会留下「HEAD 在、但缺 origin
    // remote / 非有效 git 目录」的残缺镜像，后续 `git fetch origin` 直接 fatal
    // （`'origin' does not appear to be a git repository`）。检出即删掉，按首次 clone 走完整重建。
    if (hasMirror && !(await this.isHealthyMirror(mirrorPath))) {
      this.opts.logger?.warn(
        { repo: key, mirrorPath },
        'unhealthy mirror detected (interrupted clone?); removing for full re-clone',
      );
      await fs.rm(mirrorPath, { recursive: true, force: true }).catch(() => undefined);
      hasMirror = false;
    }

    const emit = (e: Omit<SyncProgressEvent, 'repo'>): void => {
      this.opts.onProgress?.({ repo: key, ...e });
    };
    // simple-git 把 git --progress 的 stderr 解析成 { method, stage, progress } 推给我们
    const gitProgressOpt = {
      progress: ({
        method,
        stage,
        progress,
      }: {
        method: string;
        stage: string;
        progress: number;
      }): void => {
        emit({ phase: 'progress', stage, percent: progress, message: `${method} ${stage}` });
      },
    };

    emit({ phase: 'start', message: hasMirror ? 'fetching' : 'cloning' });

    try {
      if (hasMirror) {
        try {
          this.opts.logger?.debug({ repo: key }, 'mirror exists, fetching');
          // 显式 refspec，覆盖式拉：
          //   - refs/heads/*：所有分支（含 PR target 与 source 分支）
          //   - refs/pull-requests/*/from：Bitbucket 把 PR 源头 sha 单独保存在这里。
          //     当源分支已被删除 / 强推后，refs/heads 看不到，但 from ref 仍指向
          //     PR 开启时的 sha；没有它 `git diff base...head` 会 "Invalid
          //     symmetric difference" 因为 head 不可达。
          await this.withProxyEnv(simpleGit({ baseDir: mirrorPath, ...gitProgressOpt })).raw([
            'fetch',
            '--progress',
            'origin',
            '+refs/heads/*:refs/heads/*',
            '+refs/pull-requests/*/from:refs/pull-requests/*/from',
          ]);
          emit({ phase: 'done' });
          return { mirrorPath, freshClone: false };
        } catch (fetchErr) {
          // 自愈（被动）：fetch 撞上**本地损坏 / 残缺**镜像（缺 origin、坏对象等）→ 删掉，落到下方完整
          // clone 重建。其它错误（网络 / 认证 / 远端拒绝）原样抛出，不误删健康镜像、不把临时网络问题当损坏。
          if (!isLocalMirrorCorruption(fetchErr)) throw fetchErr;
          this.opts.logger?.warn(
            { repo: key, err: fetchErr instanceof Error ? fetchErr.message : String(fetchErr) },
            'fetch failed on corrupt mirror; removing for full re-clone',
          );
          await fs.rm(mirrorPath, { recursive: true, force: true }).catch(() => undefined);
          // 不 return，落到下方完整 clone 自愈重建。
        }
      }

      this.opts.logger?.info({ repo: key }, 'cloning bare mirror (full + all refs)');
      const url = await this.opts.getCloneUrl(repo);
      await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
      // --mirror 而不是 --bare：默认 --bare 只拉 refs/heads + refs/tags，
      //   Bitbucket 的 PR source sha 落在 refs/pull-requests/<id>/from 命名空间，
      //   没被拉下来就 `git diff base...head` 找不到 head sha → "Invalid
      //   symmetric difference"。--mirror 隐含 --bare 并把所有 refs 都拉下来
      //   (heads/tags/pull-requests/notes/...)，后续 fetch 也自动同步全部。
      // --no-hardlinks: 本地 upstream 别复用 hardlinks，避免 fetch 时跟 upstream
      //   状态串扰；远端 HTTPS clone 不受影响。
      // --progress: 强制 git 输出进度，否则非 TTY 模式默认静默
      //
      // 不用 --filter=blob:none：blame / pr-agent 等需要历史 blob 的工具会触发
      //   按需拉取，远端不全或 partial clone 协议未支持时直接 fatal。完整 clone
      //   一次性付清磁盘代价，运行期稳定。
      await this.withProxyEnv(simpleGit(gitProgressOpt)).clone(url, mirrorPath, [
        '--mirror',
        '--no-hardlinks',
        '--progress',
      ]);
      // Windows 等系统 fresh clone 后 FS 可能还在 flush，紧接着的 git diff
      // 有概率撞上"refs/packs 状态不一致"报错。等 git 自己能 rev-parse HEAD
      // 几次稳定后再返回，调用方拿到的 mirror 一定可用。
      await waitMirrorReady(mirrorPath, this.opts.logger);
      emit({ phase: 'done' });
      return { mirrorPath, freshClone: true };
    } catch (err) {
      emit({
        phase: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private repoKey(repo: RepoIdentity): string {
    return `${repo.host}/${repo.projectKey}/${repo.repoSlug}`;
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async dirSize(dir: string): Promise<number> {
    let total = 0;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await this.dirSize(full);
      } else if (entry.isFile()) {
        total += (await fs.stat(full)).size;
      }
    }
    return total;
  }
}

/**
 * 错误消息是否指向**本地镜像损坏 / 残缺**（而非网络 / 认证 / 远端拒绝等可重试的远端问题）。fetch 失败
 * 后据此判断是否「删库重 clone」自愈——只对本地损坏自愈，避免把临时网络问题误判为损坏而无谓全量重建。
 * 不匹配 "could not read from remote repository"：它对网络 / 认证失败也会出现，不能据它判定本地损坏。
 */
function isLocalMirrorCorruption(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('does not appear to be a git repository') || // 缺 origin remote（中断的 clone）
    msg.includes('not a git repository') ||
    msg.includes('bad object') ||
    msg.includes('object file is empty') ||
    msg.includes('loose object') || // "loose object <sha> is corrupt"
    msg.includes('did not send all necessary objects') ||
    msg.includes('unable to read')
  );
}

/**
 * Fresh clone 后稳定性兜底：轮询 `git rev-parse HEAD` 直到成功，最多 ~5 次共
 * 500ms。Windows 文件系统 / 杀毒软件可能让 pack 写入有短暂延迟，此函数把这段
 * 等待从调用方挪到 mirror 自身。
 */
async function waitMirrorReady(mirrorPath: string, logger?: Logger): Promise<void> {
  const tries = [40, 80, 120, 200, 320];
  for (const delay of tries) {
    try {
      await simpleGit(mirrorPath).raw(['rev-parse', '--verify', 'HEAD']);
      return;
    } catch {
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
  logger?.warn({ mirrorPath }, 'mirror not ready after settle window; proceeding anyway');
}

/**
 * 把 git 调用包一层重试：错误消息匹配"刚 clone 完镜像还没就绪"族（Invalid
 * symmetric difference / bad revision / unknown revision），就 sleep 一会儿再
 * 试一次，最多 3 次（含首次）。其它错误 (network / no such path / 真实 sha
 * 不存在) 立刻抛，不浪费时间。
 */
const TRANSIENT_GIT_RE =
  /Invalid symmetric difference expression|bad revision|unknown revision or path not in the working tree/i;

async function retryTransientGit<T>(
  op: () => Promise<T>,
  logger?: Logger,
  ctx?: Record<string, unknown>,
): Promise<T> {
  const delays = [200, 400];
  let lastErr: unknown;
  try {
    return await op();
  } catch (err) {
    lastErr = err;
  }
  for (const delay of delays) {
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    if (!TRANSIENT_GIT_RE.test(msg)) throw lastErr;
    logger?.debug({ ...ctx, delay }, 'transient git error; retrying after settle');
    await new Promise<void>((r) => setTimeout(r, delay));
    try {
      return await op();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * 解析 `git diff -z --name-status A...B` 的输出。
 * 格式（NUL 分隔）：
 *   M\0path\0M\0path\0
 *   A\0newpath\0
 *   D\0oldpath\0
 *   R100\0oldpath\0newpath\0
 *   C75\0srcpath\0dstpath\0
 */
function parseNameStatusZ(raw: string): ChangedFile[] {
  const tokens = raw.split(' ').filter((t) => t.length > 0);
  const out: ChangedFile[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i]!;
    const letter = code[0]!;
    const similarity = code.length > 1 ? Number.parseInt(code.slice(1), 10) : undefined;
    const status = mapStatusLetter(letter);
    if (status === 'renamed' || status === 'copied') {
      const oldPath = tokens[i + 1];
      const path = tokens[i + 2];
      if (oldPath !== undefined && path !== undefined) {
        out.push({ path, oldPath, status, similarity });
      }
      i += 3;
    } else {
      const path = tokens[i + 1];
      if (path !== undefined) out.push({ path, status });
      i += 2;
    }
  }
  return out;
}

/**
 * 解析 `git merge-tree --write-tree --name-only -z` 在冲突时的 stdout。
 * 格式（NUL 分隔）：`<结果 tree OID>\0<冲突文件名>\0...\0\0<提示信息段...>`——首字段是 tree OID，随后
 * 是各冲突文件名，遇空字段（段间双 NUL）即冲突文件段结束，后续提示信息段忽略。同名去重。
 */
export function parseMergeTreeConflictsZ(raw: string): string[] {
  const parts = raw.split('\0');
  const files: string[] = [];
  // parts[0] = 结果 tree OID；从下一字段起收集冲突文件名，遇空字段（段分隔）停止。
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] === '') break;
    files.push(parts[i]!);
  }
  return [...new Set(files)];
}

/**
 * 解析 `git blame --porcelain` 输出。每个 hunk 头形如：
 *   `<sha> <origLine> <finalLine> [<numLines>]`
 * 接着是 `key value` 元信息（author / author-mail / author-time / summary 等），
 * 最后是制表符开头的源码行 `\t<line>`。同一个 commit 的后续 hunk 头只带 sha
 * 那一行，元信息要从首次出现的 hunk 头继承。
 */
/**
 * 解析 `git diff -U0` 的 hunk 头，收集 head 一侧的"被修改"行号集合。
 * Hunk 头形如 `@@ -A,B +C,D @@`：右侧 C..C+D-1 段是 head 引入/修改的行。
 * 缺省 count 视为 1；count=0 是纯删除位，head 侧 0 行，跳过。
 */
export function parseHunkAddedLines(raw: string): Set<number> {
  const out = new Set<number>();
  for (const line of raw.split(/\r?\n/)) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number.parseInt(m[1]!, 10);
    const count = m[2] !== undefined ? Number.parseInt(m[2], 10) : 1;
    for (let i = 0; i < count; i++) out.add(start + i);
  }
  return out;
}

export function parseBlamePorcelain(raw: string): BlameLine[] {
  // Windows 上 git 输出常带 \r\n；用兼容 split 切，否则 `^...(\d+)$` 正则末尾
  // 会留下 \r 导致全部 hunk 头匹配失败 → 解析出空数组 → blame 不显示也不报错
  const lines = raw.split(/\r?\n/);
  const commitMeta = new Map<
    string,
    { author: string; authorEmail: string; authorTime: number; summary: string }
  >();
  const out: BlameLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const head = lines[i];
    if (!head) {
      i++;
      continue;
    }
    const m = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(head);
    if (!m) {
      i++;
      continue;
    }
    const sha = m[1]!;
    const finalLine = Number.parseInt(m[3]!, 10);
    let author = '';
    let authorEmail = '';
    let authorTime = 0;
    let summary = '';
    i++;
    while (i < lines.length && !lines[i]!.startsWith('\t')) {
      const meta = lines[i]!;
      const sp = meta.indexOf(' ');
      const key = sp < 0 ? meta : meta.slice(0, sp);
      const value = sp < 0 ? '' : meta.slice(sp + 1);
      if (key === 'author') author = value;
      else if (key === 'author-mail') authorEmail = value.replace(/^<|>$/g, '');
      else if (key === 'author-time') authorTime = Number.parseInt(value, 10);
      else if (key === 'summary') summary = value;
      i++;
    }
    // 跳过源码行（\t 开头那一行不算 metadata）
    if (i < lines.length && lines[i]!.startsWith('\t')) i++;

    let meta = commitMeta.get(sha);
    if (!meta && author) {
      meta = { author, authorEmail, authorTime, summary };
      commitMeta.set(sha, meta);
    }
    meta ??= commitMeta.get(sha) ?? { author: '', authorEmail: '', authorTime: 0, summary: '' };

    out.push({
      line: finalLine,
      commit: sha,
      author: meta.author,
      authorEmail: meta.authorEmail,
      authorDate: meta.authorTime ? new Date(meta.authorTime * 1000).toISOString() : '',
      summary: meta.summary,
    });
  }
  return out;
}

function mapStatusLetter(letter: string): ChangedFileStatus {
  switch (letter) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    default:
      return 'modified';
  }
}
