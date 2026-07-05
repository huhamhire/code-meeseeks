import { beforeEach, describe, expect, it } from 'vitest';
import type { StateStore } from '@meebox/state-store';
import {
  getAutopilotLedger,
  needsAutoReview,
  writeAutopilotLedger,
} from '../src/autopilot-ledger.js';

class MemStore implements StateStore {
  private m = new Map<string, unknown>();
  async read<T>(key: string): Promise<T | null> {
    return this.m.has(key) ? (structuredClone(this.m.get(key)) as T) : null;
  }
  async write<T>(key: string, data: T): Promise<void> {
    this.m.set(key, structuredClone(data));
  }
  async delete(key: string): Promise<void> {
    this.m.delete(key);
  }
  async *list(prefix: string): AsyncIterable<string> {
    for (const k of this.m.keys()) if (k === prefix || k.startsWith(`${prefix}/`)) yield k;
  }
  async deleteDir(prefix: string): Promise<void> {
    for (const k of [...this.m.keys()]) if (k === prefix || k.startsWith(`${prefix}/`)) this.m.delete(k);
  }
}

const PR = 'pr123';
let store: MemStore;
beforeEach(() => {
  store = new MemStore();
});

describe('autopilot ledger', () => {
  it('write + get round-trips', async () => {
    await writeAutopilotLedger(store, {
      prLocalId: PR,
      autoReviewedUpdatedAt: 't1',
      decision: 'review',
      recommendation: 'approve',
      at: '2026-06-15T10:00:00.000Z',
    });
    const l = await getAutopilotLedger(store, PR);
    expect(l?.decision).toBe('review');
    expect(l?.recommendation).toBe('approve');
    expect(await getAutopilotLedger(store, 'missing')).toBeNull();
  });

  it('needsAutoReview: true when no ledger or version changed; false when same', async () => {
    expect(await needsAutoReview(store, PR, 't1')).toBe(true); // no ledger
    await writeAutopilotLedger(store, {
      prLocalId: PR,
      autoReviewedUpdatedAt: 't1',
      decision: 'review',
      at: '2026-06-15T10:00:00.000Z',
    });
    expect(await needsAutoReview(store, PR, 't1')).toBe(false); // same version
    expect(await needsAutoReview(store, PR, 't2')).toBe(true); // content changed
  });
});
