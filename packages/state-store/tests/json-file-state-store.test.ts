import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JsonFileStateStore } from '../src/json-file-state-store.js';

let tmpDir: string;
let store: JsonFileStateStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meebox-state-test-'));
  store = new JsonFileStateStore(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('JsonFileStateStore', () => {
  it('returns null for a missing key', async () => {
    expect(await store.read<unknown>('missing')).toBeNull();
  });

  it('write then read round-trips', async () => {
    await store.write('users', { ids: ['a', 'b'] });
    expect(await store.read<{ ids: string[] }>('users')).toEqual({ ids: ['a', 'b'] });
  });

  it('creates nested directories for slash-separated keys', async () => {
    await store.write('runs/pr-42/run-abc', { status: 'ok' });
    expect(await store.read<{ status: string }>('runs/pr-42/run-abc')).toEqual({ status: 'ok' });
    // sanity: the path exists on disk where we expect
    const onDisk = path.join(tmpDir, 'runs', 'pr-42', 'run-abc.json');
    await expect(fs.access(onDisk)).resolves.toBeUndefined();
  });

  it('does not leave .tmp files after a successful write', async () => {
    await store.write('atomic', { v: 1 });
    const entries = await fs.readdir(tmpDir);
    expect(entries).toEqual(['atomic.json']);
  });

  it('handles concurrent writes to the same key without ENOENT', async () => {
    // regression: when the tmp filename carries only the pid, concurrent writes of the same key share
    // one tmp, and after the first to finish renames the file away, the later one's rename hits ENOENT.
    // Each concurrent write must use its own unique tmp.
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.write('hot', { v: i })));
    const entries = await fs.readdir(tmpDir);
    expect(entries).toEqual(['hot.json']); // no leftover .tmp
    expect(await store.read<{ v: number }>('hot')).toMatchObject({ v: expect.any(Number) });
  });

  it('overwrites an existing key', async () => {
    await store.write('x', { v: 1 });
    await store.write('x', { v: 2 });
    expect(await store.read<{ v: number }>('x')).toEqual({ v: 2 });
  });

  it('delete removes the file', async () => {
    await store.write('disposable', { v: 1 });
    await store.delete('disposable');
    expect(await store.read('disposable')).toBeNull();
  });

  it('delete is a nop for a missing key', async () => {
    await expect(store.delete('never-existed')).resolves.toBeUndefined();
  });

  it('list yields keys under a prefix, recursive', async () => {
    await store.write('runs/pr-1/run-a', { v: 1 });
    await store.write('runs/pr-1/run-b', { v: 1 });
    await store.write('runs/pr-2/run-x', { v: 1 });
    await store.write('connections', { v: 1 });

    const out: string[] = [];
    for await (const key of store.list('runs')) out.push(key);
    expect(out.sort()).toEqual(['runs/pr-1/run-a', 'runs/pr-1/run-b', 'runs/pr-2/run-x']);
  });

  it('list returns nothing when prefix does not exist', async () => {
    const out: string[] = [];
    for await (const key of store.list('does/not/exist')) out.push(key);
    expect(out).toEqual([]);
  });

  it('writes valid JSON with trailing newline', async () => {
    await store.write('formatted', { hello: 'world' });
    const text = await fs.readFile(path.join(tmpDir, 'formatted.json'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({ hello: 'world' });
  });

  it('deleteDir removes the whole subtree (including subdirectories + non-.json files)', async () => {
    await store.write('prs/abc/meta', { v: 1 });
    await store.write('prs/abc/runs/run-1', { v: 1 });
    // simulate a non-.json file, ensuring it is cleared along with the rest
    await fs.writeFile(path.join(tmpDir, 'prs', 'abc', 'extra.txt'), 'hi');
    await store.deleteDir('prs/abc');
    await expect(fs.access(path.join(tmpDir, 'prs', 'abc'))).rejects.toThrow();
    // sibling directory is unaffected
    await store.write('prs/xyz/meta', { v: 1 });
    expect(await store.read('prs/xyz/meta')).toEqual({ v: 1 });
  });

  it('deleteDir is a no-op when the target does not exist', async () => {
    await expect(store.deleteDir('prs/nowhere')).resolves.toBeUndefined();
  });

  it('deleteDir refuses to clear stateDir itself (empty string / "." both treated as root)', async () => {
    await store.write('keep', { v: 1 });
    await expect(store.deleteDir('')).rejects.toThrow(/stateDir root/);
    await expect(store.deleteDir('.')).rejects.toThrow(/stateDir root/);
    // root was not destroyed, the original file is still there
    expect(await store.read('keep')).toEqual({ v: 1 });
  });

  // path traversal protection: all fs operations must land inside stateDir,
  // `..` escapes / absolute paths must be blocked, to guard against unsanitized user input spliced into key assembly
  it('read / write / delete / deleteDir / list all block ".." path traversal', async () => {
    await expect(store.read('../escape')).rejects.toThrow(/path traversal/);
    await expect(store.write('../escape', { v: 1 })).rejects.toThrow(/path traversal/);
    await expect(store.delete('../escape')).rejects.toThrow(/path traversal/);
    await expect(store.deleteDir('../escape')).rejects.toThrow(/path traversal/);
    await expect(async () => {
      for await (const _ of store.list('../escape')) void _;
    }).rejects.toThrow(/path traversal/);
  });

  it('blocks absolute-path keys (even ones pointing outside stateDir)', async () => {
    const outside = path.join(os.tmpdir(), 'meebox-outside');
    await expect(store.read(outside)).rejects.toThrow(/path traversal/);
    await expect(store.write(outside, { v: 1 })).rejects.toThrow(/path traversal/);
  });

  describe('sweepOrphanDirs', () => {
    const GRACE = 7 * 24 * 60 * 60 * 1000;
    const NOW = Date.parse('2026-06-10T00:00:00.000Z');
    // backdate the mtime of some <prefix>/<child> directory to N milliseconds ago
    const backdateDir = async (rel: string, ageMs: number): Promise<void> => {
      const t = new Date(NOW - ageMs);
      await fs.utimes(path.join(tmpDir, rel), t, t);
    };

    it('deletes orphans "not in keep + mtime past grace", keeps directories in keep / still young', async () => {
      await store.write('prs/orphan/meta', { v: 1 }); // not in keep, and backdated past grace → delete
      await store.write('prs/known/meta', { v: 1 }); // in keep → keep
      await store.write('prs/young/meta', { v: 1 }); // not in keep but still young → keep
      await backdateDir('prs/orphan', GRACE + 60_000);
      await backdateDir('prs/known', GRACE + 60_000);
      await backdateDir('prs/young', GRACE - 60_000);

      const removed = await store.sweepOrphanDirs('prs', new Set(['known']), GRACE, NOW);
      expect(removed).toBe(1);
      expect(await store.read('prs/orphan/meta')).toBeNull();
      expect(await store.read('prs/known/meta')).toEqual({ v: 1 });
      expect(await store.read('prs/young/meta')).toEqual({ v: 1 });
    });

    it('prefix directory does not exist → returns 0, does not throw', async () => {
      expect(await store.sweepOrphanDirs('archived/prs', new Set(), GRACE, NOW)).toBe(0);
    });

    it('skips non-directory entries (e.g. stray .json files)', async () => {
      await store.write('prs/index', { schema_version: 1 }); // prs/index.json is a file, not a directory
      await backdateDir('prs', GRACE + 60_000);
      const removed = await store.sweepOrphanDirs('prs', new Set(), GRACE, NOW);
      expect(removed).toBe(0);
      expect(await store.read('prs/index')).not.toBeNull();
    });
  });
});
