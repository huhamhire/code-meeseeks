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
  constructor(private readonly stateDir: string) {}

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

  async *list(prefix: string): AsyncIterable<string> {
    const root = path.join(this.stateDir, prefix);
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
    return path.join(this.stateDir, `${key}.json`);
  }
}
