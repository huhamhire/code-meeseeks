import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { StateStore } from './types.js';

/** rename 自愈重试的退避梯度（ms）；用尽仍失败则抛。 */
const RENAME_RETRY_DELAYS = [10, 25, 50, 100, 200];

/**
 * 把 key 映射到 `<stateDir>/<key>.json`，写入走 "tmp → fsync → rename" 原子模式。
 *
 * 假设单写者（Electron Main 进程独占），不做文件锁。多进程并发写同一 key 时，
 * 最后一个 rename 胜出但中间不会出现半截文件。
 *
 * Windows 自愈：同一 key 被并发写（多个 IPC handler 同时落同一份缓存，如打开 PR 时
 * 多路并发算 diff-base）时，`fs.rename` 覆盖既有文件可能撞上瞬时 EPERM/EACCES/EBUSY
 * （目标正被另一并发 rename / 杀软 / 其它句柄短暂占用——POSIX 原子替换不会，Windows 会）。
 * 这是瞬时锁而非真实权限问题，小退避重试即自愈；用尽重试才抛。
 */
export class JsonFileStateStore implements StateStore {
  private readonly rootResolved: string;
  /** tmp 文件名去重计数器：避免同进程内对同一 key 的并发写撞用同一 tmp 路径 */
  private tmpSeq = 0;

  constructor(
    private readonly stateDir: string,
    private readonly logger?: Logger,
  ) {
    this.rootResolved = path.resolve(stateDir);
  }

  async read<T>(key: string): Promise<T | null> {
    const filePath = this.keyToPath(key);
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    return JSON.parse(text) as T;
  }

  async write<T>(key: string, data: T): Promise<void> {
    const filePath = this.keyToPath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // pid 隔离多进程、tmpSeq 隔离同进程内对同一 key 的并发写——否则两次并发写
    // 共用同一 tmp，先完成者 rename 走文件后，后完成者 rename 即 ENOENT。
    const tmp = `${filePath}.${String(process.pid)}.${String(this.tmpSeq++)}.tmp`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(data, null, 2) + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.renameWithRetry(tmp, filePath, key);
  }

  /**
   * `fs.rename(tmp → dest)`，对 Windows 并发写的瞬时 EPERM/EACCES/EBUSY 做退避重试自愈。
   * rename 失败时 tmp 仍在原地，直接重试同一次 rename 即可。重试用尽 / 非瞬时错误：清理 tmp 后抛。
   * 每次自愈重试打 warn 级定位日志（key / dest / errno code / 第几次）。
   */
  private async renameWithRetry(tmp: string, dest: string, key: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, dest);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
        if (!transient || attempt >= RENAME_RETRY_DELAYS.length) {
          // 用尽重试 / 非瞬时错误：清掉残留 tmp（best-effort）后抛原始错误
          await fs.rm(tmp, { force: true }).catch(() => undefined);
          throw e;
        }
        const delay = RENAME_RETRY_DELAYS[attempt]!;
        this.logger?.warn(
          { key, dest, code, attempt: attempt + 1, delayMs: delay },
          'state-store: transient rename failure (likely Windows concurrent-write lock); self-healing via backoff retry',
        );
        await new Promise<void>((r) => setTimeout(r, delay));
      }
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.keyToPath(key);
    try {
      await fs.unlink(filePath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }

  async deleteDir(prefix: string): Promise<void> {
    const fullPath = this.subpathInside(prefix);
    // 双重保险：subpathInside 已经挡了越界，但避免误传空串 ('') 一刀清掉 stateDir 自身
    if (fullPath === this.rootResolved) {
      throw new Error('state-store: refused to deleteDir on stateDir root');
    }
    // recursive + force：不存在 / 是空目录 / 含子目录都接住，对应需求是"清掉整棵子树"
    await fs.rm(fullPath, { recursive: true, force: true });
  }

  async *list(prefix: string): AsyncIterable<string> {
    const root = this.subpathInside(prefix);
    try {
      await fs.access(root);
    } catch {
      return;
    }
    yield* this.walk(root);
  }

  private async *walk(dir: string): AsyncIterable<string> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* this.walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        const rel = path.relative(this.stateDir, full).replace(/\\/g, '/');
        yield rel.replace(/\.json$/, '');
      }
    }
  }

  private keyToPath(key: string): string {
    return this.subpathInside(`${key}.json`);
  }

  /**
   * 安全屏障：所有文件系统操作必须落到 stateDir 内部。`..` 跳出 / 绝对路径 / 符号
   * 链接构造出的越界 key 都在此被拦截。
   *
   * 为什么必须：StateStore key 由调用方拼接 (含 PR localId / runId / 评论缓存等)，
   * 一旦 key 在某个分支拼了未净化的用户输入 (比如远端 PR slug 含 `../`)，没有这层
   * 屏障就能在用户工作目录之外读写文件。meebox 写过 user-controlled 字段进 key
   * 的路径 (rules.dir id / repo slug / 远端 url 派生的 connectionId) 必须挡住。
   */
  private subpathInside(rel: string): string {
    const joined = path.resolve(this.stateDir, rel);
    if (joined !== this.rootResolved && !joined.startsWith(this.rootResolved + path.sep)) {
      throw new Error(
        `state-store: refused path traversal (key resolves outside stateDir): ${rel}`,
      );
    }
    return joined;
  }
}
