import fs from 'node:fs/promises';
import path from 'node:path';
import type { StateStore } from './types.js';

/**
 * 把 key 映射到 `<stateDir>/<key>.json`，写入走 "tmp → fsync → rename" 原子模式。
 *
 * 假设单写者（Electron Main 进程独占），不做文件锁。多进程并发写同一 key 时，
 * 最后一个 rename 胜出但中间不会出现半截文件。
 */
export class JsonFileStateStore implements StateStore {
  private readonly rootResolved: string;

  constructor(private readonly stateDir: string) {
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

    const tmp = `${filePath}.${String(process.pid)}.tmp`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(data, null, 2) + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, filePath);
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
   * 屏障就能在用户工作目录之外读写文件。pr-pilot 写过 user-controlled 字段进 key
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
