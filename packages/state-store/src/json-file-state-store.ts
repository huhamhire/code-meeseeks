import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import type { StateStore } from './types.js';

/** Backoff gradient (ms) for rename self-healing retries; throws if exhausted and still failing. */
const RENAME_RETRY_DELAYS = [10, 25, 50, 100, 200];

/**
 * Maps a key to `<stateDir>/<key>.json`; writes go through the "tmp → fsync → rename" atomic pattern.
 *
 * Assumes a single writer (Electron Main process exclusive), no file locking. When multiple
 * processes write the same key concurrently, the last rename wins but no half-written file
 * ever appears in between.
 *
 * Windows self-healing: when the same key is written concurrently (multiple IPC handlers
 * flushing the same cache, e.g. multi-path parallel diff-base computation when opening a PR),
 * `fs.rename` overwriting an existing file may hit transient EPERM/EACCES/EBUSY (the target
 * is briefly held by another concurrent rename / antivirus / another handle — POSIX atomic
 * replace won't, Windows will). This is a transient lock rather than a real permission problem;
 * a small backoff retry self-heals; only throws once retries are exhausted.
 */
export class JsonFileStateStore implements StateStore {
  private readonly rootResolved: string;
  /** tmp filename dedup counter: avoids concurrent writes of the same key within one process colliding on the same tmp path */
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

    // pid isolates across processes, tmpSeq isolates concurrent writes of the same key within one
    // process — otherwise two concurrent writes share one tmp, and after the first to finish renames
    // the file away, the second's rename hits ENOENT.
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
   * `fs.rename(tmp → dest)`, self-heals transient EPERM/EACCES/EBUSY from Windows concurrent writes
   * via backoff retry. When rename fails the tmp is still in place, so just retry the same rename.
   * Retries exhausted / non-transient error: clean up tmp then throw.
   * Each self-healing retry logs a warn-level diagnostic (key / dest / errno code / which attempt).
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
          // retries exhausted / non-transient error: remove leftover tmp (best-effort) then throw the original error
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
   * Sweeps leftover atomic-write temp files (`*.tmp`). A normal successful write renames the tmp away,
   * and a failure (including exhausted rename retries) actively rm's it; but a process force-killed /
   * exited between "write tmp" and "rename" (e.g. an in-flight async write still pending at window close)
   * leaves an orphan tmp that accumulates across sessions over time.
   *
   * **Only safe to call at startup, before any write**: under the single-writer premise (Electron Main
   * exclusive) there is no in-flight write at this moment, so every `*.tmp` is an orphan from the last
   * session and safe to delete; **never sweep at runtime** — that would wrongly delete a tmp in use by a
   * concurrent write / rename retry (in the conflict scenario no extra file is generated, nor wrongly
   * deleted). best-effort: a single deletion failure only logs, does not throw. Returns the number of
   * files swept.
   */
  async sweepStaleTmpFiles(): Promise<number> {
    let removed = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // directory does not exist / not readable: ignore
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
   * Sweeps orphan child directories under `<prefix>/<child>/`: deletes the whole tree of any `child`
   * that is not in the `keep` set **and** whose directory mtime is earlier than `nowMs - olderThanMs`.
   * Used at startup to reclaim orphans in archived cold storage — after the unified index is lost /
   * rebuilt, archived entries lose their directory index and the index-driven hard cleanup can't reach
   * them (see docs/arch/99-core/01-state-storage). With no index to rely on, directory mtime serves as
   * a proxy for archivedAt (the index was lost along with it).
   *
   * **Doubly conservative**: only deletes when both "not in keep" + "mtime past grace" hold — avoids
   * wrongly deleting a directory that is merely temporarily absent from the index (e.g. an interrupted
   * relocation). **Only safe to call at startup, before any write** (under the single-writer premise no
   * in-flight relocation would be misjudged as an orphan). Traverses direct children of the subdirectory,
   * no recursive judgement; non-directory entries are skipped. best-effort: a single failure only logs,
   * does not throw. Returns the number of orphan directories deleted.
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
      return 0; // prefix directory does not exist / not readable
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
      if (nowMs - mtimeMs <= olderThanMs) continue; // too new: leave it for now (conservative)
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
    // double safeguard: subpathInside already blocks traversal, but guard against a stray empty string ('') wiping stateDir itself
    if (fullPath === this.rootResolved) {
      throw new Error('state-store: refused to deleteDir on stateDir root');
    }
    // recursive + force: handles nonexistent / empty directory / with subdirectories alike, matching the need to "clear the whole subtree"
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
   * Safety barrier: every filesystem operation must land inside stateDir. Out-of-bounds keys
   * constructed via `..` escapes / absolute paths / symbolic links are all intercepted here.
   *
   * Why required: StateStore keys are assembled by callers (containing PR localId / runId /
   * comment cache etc.), and once a key on some branch splices in unsanitized user input (e.g.
   * a remote PR slug containing `../`), without this barrier it could read/write files outside
   * the user's working directory. Paths where meebox writes user-controlled fields into keys
   * (rules.dir id / repo slug / connectionId derived from remote url) must be blocked.
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
