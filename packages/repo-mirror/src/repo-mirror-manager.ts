import fs from 'node:fs/promises';
import path from 'node:path';
import simpleGit from 'simple-git';
import type { Logger } from 'pino';
import type { MirrorResult, RepoIdentity, RepoSize } from './types.js';

export interface RepoMirrorOptions {
  /** repos_dir 根（来自 config.workspace.repos_dir，已展开 ~） */
  reposDir: string;
  /** 由 PlatformAdapter 提供：给一个 repo 返回带认证的 clone URL */
  getCloneUrl: (repo: RepoIdentity) => Promise<string>;
  logger?: Logger;
}

/**
 * 本地 git 镜像管理。一仓一队列，避免同一个 repo 的并发 fetch / worktree
 * 操作互相打架（git index lock）。不同 repo 可并行。
 *
 * 策略：`git clone --bare --filter=blob:none`。metadata 全要，blobs 按需下，
 * 适合 review 场景磁盘占用最小。后续 fetch 走 `git fetch`，增量。
 *
 * 不做 worktree。M2 范围内 diff 计算走 `git show <sha>:<path>`，不需要把
 * 文件 checkout 到磁盘。M3 接 pr-agent 时再看是否需要 worktree。
 */
export class RepoMirrorManager {
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: RepoMirrorOptions) {}

  /** 计算 bare 镜像应当落在哪里（不保证存在）。 */
  mirrorPath(repo: RepoIdentity): string {
    return path.join(
      this.opts.reposDir,
      repo.host,
      repo.projectKey,
      repo.repoSlug,
      'bare',
    );
  }

  /**
   * 同步镜像：首次 clone bare partial，后续 fetch。每个 repo 串行执行
   * （多次并发调用同一 repo 会排队），不同 repo 并行。
   */
  async syncMirror(repo: RepoIdentity): Promise<MirrorResult> {
    return this.serialize(this.repoKey(repo), () => this.doSyncMirror(repo));
  }

  /** 镜像大小（字节）。不存在返回 0。 */
  async getSize(repo: RepoIdentity): Promise<RepoSize> {
    const dir = this.mirrorPath(repo);
    if (!(await this.exists(dir))) return { totalBytes: 0 };
    return { totalBytes: await this.dirSize(dir) };
  }

  private async doSyncMirror(repo: RepoIdentity): Promise<MirrorResult> {
    const mirrorPath = this.mirrorPath(repo);
    const hasMirror = await this.exists(path.join(mirrorPath, 'HEAD'));
    const key = this.repoKey(repo);

    if (hasMirror) {
      this.opts.logger?.debug({ repo: key }, 'mirror exists, fetching');
      // 显式 refspec，强制把 origin 的所有分支 ref 拉到本地（覆盖式）。
      // 不依赖 simple-git 默认 fetch 行为。
      await simpleGit(mirrorPath).raw(['fetch', 'origin', '+refs/heads/*:refs/heads/*']);
      return { mirrorPath, freshClone: false };
    }

    this.opts.logger?.info({ repo: key }, 'cloning bare mirror (partial blob:none)');
    const url = await this.opts.getCloneUrl(repo);
    await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
    // --no-hardlinks: 本地 upstream 别复用 hardlinks，避免 fetch 时跟 upstream
    //   状态串扰；远端 HTTPS clone 不受影响。
    // --filter=blob:none: 拉 metadata 不拉 blobs，blobs 按需下。远端 BBS 7.0+
    //   支持 partial clone 协议；不支持时 git 自动 fallback 到完整克隆。
    await simpleGit().clone(url, mirrorPath, [
      '--bare',
      '--no-hardlinks',
      '--filter=blob:none',
    ]);
    return { mirrorPath, freshClone: true };
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

  /**
   * 一仓一队列：相同 key 的操作串行排队执行，不同 key 并行。
   * 不论 prev 成败都执行 next，避免某次失败堵死后续。
   */
  private async serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = (this.pending.get(key) ?? Promise.resolve()) as Promise<unknown>;
    const next = prev.then(fn, fn) as Promise<T>;
    this.pending.set(key, next as Promise<unknown>);
    try {
      return await next;
    } finally {
      if (this.pending.get(key) === (next as Promise<unknown>)) {
        this.pending.delete(key);
      }
    }
  }
}
