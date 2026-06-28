import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonFileStateStore } from '@meebox/state-store';
import { sweepOrphanedArchivedPrs } from '../src/archive-housekeeping.js';
import { PR_INDEX_KEY, type PrIndexFile } from '../src/pr-state.js';

const GRACE = 7 * 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-10T00:00:00.000Z');

let tmpDir: string;
let store: JsonFileStateStore; // active (state/)
let archiveStore: JsonFileStateStore; // archived/

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meebox-archive-hk-'));
  store = new JsonFileStateStore(path.join(tmpDir, 'state'));
  archiveStore = new JsonFileStateStore(path.join(tmpDir, 'archived'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// 把归档目录 mtime 回拨到超期
const backdateArchive = async (hash: string, ageMs: number): Promise<void> => {
  const t = new Date(NOW.getTime() - ageMs);
  await fs.utimes(path.join(tmpDir, 'archived', 'prs', hash), t, t);
};

const seedIndex = async (hashes: string[]): Promise<void> => {
  const prs: PrIndexFile['prs'] = {};
  for (const h of hashes) {
    prs[h] = {
      identity: {
        platform: 'bitbucket-server',
        connectionId: 'bb1',
        group: 'P',
        repo: 'r',
        remoteId: h,
        url: 'https://example/x',
      },
      updatedAt: NOW.toISOString(),
      discoveredAt: NOW.toISOString(),
      lastSeenAt: NOW.toISOString(),
      archivedAt: NOW.toISOString(),
    };
  }
  await store.write<PrIndexFile>(PR_INDEX_KEY, { schema_version: 1, prs });
};

describe('sweepOrphanedArchivedPrs', () => {
  it('删除「索引无条目 + 超 grace」的归档孤儿，保留仍被索引登记的', async () => {
    await archiveStore.write('prs/known/meta', { v: 1 });
    await archiveStore.write('prs/orphan/meta', { v: 1 });
    await backdateArchive('known', GRACE + 60_000);
    await backdateArchive('orphan', GRACE + 60_000);
    await seedIndex(['known']); // 只有 known 在索引里

    const removed = await sweepOrphanedArchivedPrs({ stateStore: store, archiveStore, now: () => NOW });
    expect(removed).toBe(1);
    expect(await archiveStore.read('prs/known/meta')).not.toBeNull();
    expect(await archiveStore.read('prs/orphan/meta')).toBeNull();
  });

  it('索引整个丢失时也只清超 grace 的孤儿、不动仍年轻的', async () => {
    await archiveStore.write('prs/old/meta', { v: 1 });
    await archiveStore.write('prs/recent/meta', { v: 1 });
    await backdateArchive('old', GRACE + 60_000);
    await backdateArchive('recent', GRACE - 60_000);
    // 不写索引（模拟索引丢失）→ keep 为空

    const removed = await sweepOrphanedArchivedPrs({ stateStore: store, archiveStore, now: () => NOW });
    expect(removed).toBe(1);
    expect(await archiveStore.read('prs/old/meta')).toBeNull(); // 超期 → 清
    expect(await archiveStore.read('prs/recent/meta')).not.toBeNull(); // 年轻 → 保留（保守）
  });
});
