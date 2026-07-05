import { beforeEach, describe, expect, it } from 'vitest';
import type { StateStore } from '@meebox/state-store';
import {
  appendAgentStep,
  clearAgentSession,
  getAgentSession,
  getAgentTranscript,
  startAgentSession,
  updateAgentSession,
} from '../src/agent-session.js';

/** In-memory StateStore: covers read/write/delete/list/deleteDir, for unit-testing persistence logic. */
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

const PR = 'abc123def456';
const fixedNow = (): Date => new Date('2026-06-15T10:00:00.000Z');

let store: MemStore;
beforeEach(() => {
  store = new MemStore();
});

describe('startAgentSession', () => {
  it('writes a running session + empty transcript', async () => {
    const s = await startAgentSession(store, { prLocalId: PR, maxSteps: 5 }, fixedNow);
    expect(s.status).toBe('running');
    expect(s.stepCount).toBe(0);
    expect(s.todo).toEqual([]);
    expect(s.maxSteps).toBe(5);
    expect(s.prLocalId).toBe(PR);

    expect(await getAgentSession(store, PR)).toEqual(s);
    expect(await getAgentTranscript(store, PR)).toEqual([]);
  });

  it('uses an external id when given', async () => {
    const s = await startAgentSession(store, { prLocalId: PR, maxSteps: 3, id: 'sess-1' });
    expect(s.id).toBe('sess-1');
  });

  it('resets the transcript on restart', async () => {
    await startAgentSession(store, { prLocalId: PR, maxSteps: 5 });
    await appendAgentStep(store, PR, { kind: 'plan', thought: 'first' });
    expect(await getAgentTranscript(store, PR)).toHaveLength(1);
    await startAgentSession(store, { prLocalId: PR, maxSteps: 5 });
    expect(await getAgentTranscript(store, PR)).toEqual([]);
  });
});

describe('updateAgentSession', () => {
  it('merges a patch and rewrites', async () => {
    await startAgentSession(store, { prLocalId: PR, maxSteps: 5 });
    const next = await updateAgentSession(store, PR, {
      status: 'done',
      summary: 'looks fine',
      recommendation: { verdict: 'approve', reason: 'no issues' },
      finishedAt: '2026-06-15T10:01:00.000Z',
    });
    expect(next?.status).toBe('done');
    expect(next?.summary).toBe('looks fine');
    expect(next?.recommendation?.verdict).toBe('approve');
    expect((await getAgentSession(store, PR))?.status).toBe('done');
  });

  it('returns null when the session does not exist', async () => {
    expect(await updateAgentSession(store, 'missing', { status: 'done' })).toBeNull();
  });
});

describe('appendAgentStep', () => {
  it('appends to transcript, stamps at, and syncs stepCount', async () => {
    await startAgentSession(store, { prLocalId: PR, maxSteps: 5 });
    const s1 = await appendAgentStep(store, PR, { kind: 'plan', thought: 'plan it' }, fixedNow);
    expect(s1?.stepCount).toBe(1);
    const s2 = await appendAgentStep(
      store,
      PR,
      { kind: 'tool', toolCall: { tool: '/review' } },
      fixedNow,
    );
    expect(s2?.stepCount).toBe(2);

    const steps = await getAgentTranscript(store, PR);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.at).toBe('2026-06-15T10:00:00.000Z');
    expect(steps[1]?.toolCall?.tool).toBe('/review');
  });

  it('returns null when no session was started', async () => {
    expect(await appendAgentStep(store, 'missing', { kind: 'plan' })).toBeNull();
  });
});

describe('clearAgentSession', () => {
  it('removes session and transcript', async () => {
    await startAgentSession(store, { prLocalId: PR, maxSteps: 5 });
    await appendAgentStep(store, PR, { kind: 'plan' });
    await clearAgentSession(store, PR);
    expect(await getAgentSession(store, PR)).toBeNull();
    expect(await getAgentTranscript(store, PR)).toEqual([]);
  });
});
