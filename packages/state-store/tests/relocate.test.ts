import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JsonFileStateStore } from '../src/json-file-state-store.js';
import { relocateTree } from '../src/relocate.js';

let rootDir: string;
let from: JsonFileStateStore;
let to: JsonFileStateStore;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meebox-relocate-test-'));
  // Two stores rooted at sibling dirs (mirrors state/ vs archived/).
  from = new JsonFileStateStore(path.join(rootDir, 'state'));
  to = new JsonFileStateStore(path.join(rootDir, 'archived'));
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe('relocateTree', () => {
  it('moves a whole subtree to the destination store and drops the source', async () => {
    await from.write('prs/abc/meta', { v: 1 });
    await from.write('prs/abc/runs/r1', { ok: true });
    await from.write('prs/abc/runs/r2', { ok: false });
    // sibling subtree must stay put
    await from.write('prs/other/meta', { keep: true });

    const moved = await relocateTree(from, to, 'prs/abc');
    expect(moved).toBe(3);

    // destination now holds the data
    expect(await to.read('prs/abc/meta')).toEqual({ v: 1 });
    expect(await to.read('prs/abc/runs/r1')).toEqual({ ok: true });
    expect(await to.read('prs/abc/runs/r2')).toEqual({ ok: false });

    // source subtree gone, unrelated sibling untouched
    expect(await from.read('prs/abc/meta')).toBeNull();
    await expect(fs.access(path.join(rootDir, 'state', 'prs', 'abc'))).rejects.toThrow();
    expect(await from.read('prs/other/meta')).toEqual({ keep: true });
  });

  it('is a no-op when the source subtree is missing', async () => {
    const moved = await relocateTree(from, to, 'prs/ghost');
    expect(moved).toBe(0);
    expect(await to.read('prs/ghost/meta')).toBeNull();
  });

  it('replaces stale data already present at the destination', async () => {
    await to.write('prs/abc/meta', { stale: true });
    await to.write('prs/abc/runs/old', { dropMe: true });
    await from.write('prs/abc/meta', { fresh: true });

    await relocateTree(from, to, 'prs/abc');

    expect(await to.read('prs/abc/meta')).toEqual({ fresh: true });
    // stale key not present in source must be cleared (destination replaced wholesale)
    expect(await to.read('prs/abc/runs/old')).toBeNull();
  });

  it('round-trips back (archive → active) preserving values', async () => {
    await from.write('prs/abc/meta', { phase: 'active' });
    await relocateTree(from, to, 'prs/abc');
    const back = await relocateTree(to, from, 'prs/abc');
    expect(back).toBe(1);
    expect(await from.read('prs/abc/meta')).toEqual({ phase: 'active' });
    expect(await to.read('prs/abc/meta')).toBeNull();
  });
});
