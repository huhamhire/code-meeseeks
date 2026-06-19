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
    // 回归：tmp 文件名仅带 pid 时，同 key 的并发写共用同一 tmp，先完成者 rename 走文件后
    // 后完成者 rename 即 ENOENT。各并发写须各用唯一 tmp。
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.write('hot', { v: i })));
    const entries = await fs.readdir(tmpDir);
    expect(entries).toEqual(['hot.json']); // 无遗留 .tmp
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

  it('deleteDir removes the whole subtree (含子目录 + 非 .json 文件)', async () => {
    await store.write('prs/abc/meta', { v: 1 });
    await store.write('prs/abc/runs/run-1', { v: 1 });
    // 模拟非 .json 文件，确保也被一并清掉
    await fs.writeFile(path.join(tmpDir, 'prs', 'abc', 'extra.txt'), 'hi');
    await store.deleteDir('prs/abc');
    await expect(fs.access(path.join(tmpDir, 'prs', 'abc'))).rejects.toThrow();
    // 兄弟目录不受影响
    await store.write('prs/xyz/meta', { v: 1 });
    expect(await store.read('prs/xyz/meta')).toEqual({ v: 1 });
  });

  it('deleteDir 是 no-op 当目标不存在', async () => {
    await expect(store.deleteDir('prs/nowhere')).resolves.toBeUndefined();
  });

  it('deleteDir 拒绝清空 stateDir 自身 (空串 / "." 都视作 root)', async () => {
    await store.write('keep', { v: 1 });
    await expect(store.deleteDir('')).rejects.toThrow(/stateDir root/);
    await expect(store.deleteDir('.')).rejects.toThrow(/stateDir root/);
    // root 没被毁，原文件还在
    expect(await store.read('keep')).toEqual({ v: 1 });
  });

  // 路径越界保护：所有 fs 操作必须落在 stateDir 内部，
  // `..` 跳出 / 绝对路径都得被挡，以防 key 拼接里混入未净化的用户输入
  it('read / write / delete / deleteDir / list 全都挡 ".." path traversal', async () => {
    await expect(store.read('../escape')).rejects.toThrow(/path traversal/);
    await expect(store.write('../escape', { v: 1 })).rejects.toThrow(/path traversal/);
    await expect(store.delete('../escape')).rejects.toThrow(/path traversal/);
    await expect(store.deleteDir('../escape')).rejects.toThrow(/path traversal/);
    await expect(async () => {
      for await (const _ of store.list('../escape')) void _;
    }).rejects.toThrow(/path traversal/);
  });

  it('挡绝对路径 key（即使指向 stateDir 之外）', async () => {
    const outside = path.join(os.tmpdir(), 'meebox-outside');
    await expect(store.read(outside)).rejects.toThrow(/path traversal/);
    await expect(store.write(outside, { v: 1 })).rejects.toThrow(/path traversal/);
  });
});
