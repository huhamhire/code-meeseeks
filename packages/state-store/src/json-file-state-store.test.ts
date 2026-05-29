import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JsonFileStateStore } from './json-file-state-store.js';

let tmpDir: string;
let store: JsonFileStateStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-pilot-state-test-'));
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
});
