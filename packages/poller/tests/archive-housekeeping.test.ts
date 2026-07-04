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

// Backdate the archive directory's mtime to past the grace period
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
  it('deletes archived orphans "no index entry + past grace", keeps those still registered in the index', async () => {
    await archiveStore.write('prs/known/meta', { v: 1 });
    await archiveStore.write('prs/orphan/meta', { v: 1 });
    await backdateArchive('known', GRACE + 60_000);
    await backdateArchive('orphan', GRACE + 60_000);
    await seedIndex(['known']); // only known is in the index

    const removed = await sweepOrphanedArchivedPrs({ stateStore: store, archiveStore, now: () => NOW });
    expect(removed).toBe(1);
    expect(await archiveStore.read('prs/known/meta')).not.toBeNull();
    expect(await archiveStore.read('prs/orphan/meta')).toBeNull();
  });

  it('even when the whole index is lost, only sweeps orphans past grace, leaving still-young ones alone', async () => {
    await archiveStore.write('prs/old/meta', { v: 1 });
    await archiveStore.write('prs/recent/meta', { v: 1 });
    await backdateArchive('old', GRACE + 60_000);
    await backdateArchive('recent', GRACE - 60_000);
    // do not write the index (simulate index loss) → keep is empty

    const removed = await sweepOrphanedArchivedPrs({ stateStore: store, archiveStore, now: () => NOW });
    expect(removed).toBe(1);
    expect(await archiveStore.read('prs/old/meta')).toBeNull(); // past grace → swept
    expect(await archiveStore.read('prs/recent/meta')).not.toBeNull(); // young → kept (conservative)
  });
});
