import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
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

  /**
   * 清扫残留的原子写临时文件（`*.tmp`）。正常写成功即 rename 走 tmp、失败（含 rename 重试用尽）也会主动 rm；
   * 但进程在「write tmp」与「rename」之间被强杀 / 退出（如关窗瞬间仍有 in-flight 的异步写）会留下孤儿 tmp，
   * 跨会话长期累积。
   *
   * **仅在启动、任何写入之前调用**才安全：单写者前提（Electron Main 独占）下，此刻不存在 in-flight 写，凡 `*.tmp`
   * 皆为上次会话的孤儿，可放心删；**绝不在运行期清扫**——否则会误删并发写 / rename 重试正在用的 tmp（冲突场景下
   * 不生成、也不误删多余文件）。best-effort：单个删除失败仅记日志、不抛。返回清掉的文件数。
   */
  async sweepStaleTmpFiles(): Promise<number> {
    let removed = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // 目录不存在 / 不可读：忽略
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.tmp')) {
          try {
            await fs.unlink(full);
            removed++;
          } catch (e) {
            this.logger?.warn({ err: e, file: full }, 'state-store: failed to sweep stale tmp file');
          }
        }
      }
    };
    await walk(this.rootResolved);
    if (removed > 0) this.logger?.info({ removed }, 'state-store: swept stale tmp files at startup');
    return removed;
  }

  /**
   * 清扫 `<prefix>/<child>/` 下的孤儿子目录：`child` 不在 `keep` 集**且**目录 mtime 早于 `nowMs - olderThanMs`
   * 的整树删掉。用于启动期回收归档冷存储里的孤儿——统一索引丢失 / 被重建后，归档条目失去目录索引，
   * 按索引遍历的硬清够不到它（见 docs/arch/03）。无索引可依，故以目录 mtime 作 archivedAt 的代理（索引一并丢了）。
   *
   * **双重保守**：必须同时「不在 keep」+「mtime 超期」才删——避免误删一个只是暂时不在索引里的目录（如中断的搬迁）。
   * **仅启动期、任何写入之前调用**才安全（单写者前提下此刻无 in-flight 搬迁会被误判为孤儿）。子目录直接子级遍历、
   * 不递归判定；非目录项跳过。best-effort：单个失败仅记日志、不抛。返回删除的孤儿目录数。
   */
  async sweepOrphanDirs(
    prefix: string,
    keep: ReadonlySet<string>,
    olderThanMs: number,
    nowMs: number,
  ): Promise<number> {
    const root = this.subpathInside(prefix);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return 0; // prefix 目录不存在 / 不可读
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || keep.has(entry.name)) continue;
      const dir = path.join(root, entry.name);
      let mtimeMs: number;
      try {
        mtimeMs = (await fs.stat(dir)).mtimeMs;
      } catch {
        continue;
      }
      if (nowMs - mtimeMs <= olderThanMs) continue; // 太新：暂不动（保守）
      try {
        await fs.rm(dir, { recursive: true, force: true });
        removed++;
        this.logger?.info(
          { dir: `${prefix}/${entry.name}`, ageMs: nowMs - mtimeMs },
          'state-store: swept orphaned dir (no index entry, aged past grace)',
        );
      } catch (e) {
        this.logger?.warn({ err: e, dir }, 'state-store: failed to sweep orphaned dir');
      }
    }
    return removed;
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
