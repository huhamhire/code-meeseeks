import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from 'pino';
import { JsonFileStateStore } from '@pr-pilot/state-store';
import type { PlatformAdapter, PullRequest } from '@pr-pilot/shared';
import { Poller, listStoredPullRequests, setLocalStatus } from './poller.js';
import { PR_INDEX_KEY, type PullRequestsIndexFile } from './types.js';

class FakeAdapter implements PlatformAdapter {
  readonly kind = 'bitbucket-server' as const;
  constructor(
    private prs: PullRequest[] = [],
    private failPing = false,
    private failList = false,
  ) {}
  setPrs(prs: PullRequest[]): void {
    this.prs = prs;
  }
  failNextList(): void {
    this.failList = true;
  }
  async ping() {
    if (this.failPing) throw new Error('ping fail');
    return { ok: true, serverVersion: 'fake' };
  }
  async listPendingPullRequests(): Promise<PullRequest[]> {
    if (this.failList) {
      this.failList = false;
      throw new Error('list fail');
    }
    return this.prs;
  }
}

const noop = (): void => undefined;
const noopLogger = {
  info: noop,
  debug: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  trace: noop,
  child: () => noopLogger,
  level: 'info',
} as unknown as Logger;

function makePr(id: string, updatedAt: string, title = `PR ${id}`): PullRequest {
  return {
    remoteId: id,
    title,
    description: '',
    author: { name: 'u', displayName: 'U' },
    state: 'open',
    draft: false,
    sourceRef: { displayId: 'dev', sha: 'a' },
    targetRef: { displayId: 'main', sha: 'b' },
    repo: { projectKey: 'P', repoSlug: 'r' },
    url: `https://x/${id}`,
    createdAt: '2026-05-28T00:00:00.000Z',
    updatedAt,
    reviewers: [],
  };
}

let tmpDir: string;
let store: JsonFileStateStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-pilot-poller-test-'));
  store = new JsonFileStateStore(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Poller.tick', () => {
  it('first run: inserts PRs with localStatus=pending + discoveredAt=now', async () => {
    const adapter = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const fixedNow = new Date('2026-06-01T00:00:00.000Z');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
      now: () => fixedNow,
    });

    const r = await poller.tick();
    expect(r).toEqual({ fetched: 1, changed: 0, added: 1, errors: 0 });

    const stored = await listStoredPullRequests(store);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      localId: 'bb1:1',
      connectionId: 'bb1',
      localStatus: 'pending',
      discoveredAt: fixedNow.toISOString(),
      lastSeenAt: fixedNow.toISOString(),
    });
  });

  it('second run with same PR: preserves localStatus + discoveredAt, updates lastSeenAt', async () => {
    const adapter = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    let now = new Date('2026-06-01T00:00:00.000Z');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
      now: () => now,
    });

    await poller.tick();
    await setLocalStatus(store, 'bb1:1', 'skipped');

    now = new Date('2026-06-02T00:00:00.000Z');
    const r = await poller.tick();
    expect(r).toEqual({ fetched: 1, changed: 0, added: 0, errors: 0 });

    const stored = (await listStoredPullRequests(store))[0]!;
    expect(stored.localStatus).toBe('skipped');
    expect(stored.discoveredAt).toBe('2026-06-01T00:00:00.000Z');
    expect(stored.lastSeenAt).toBe('2026-06-02T00:00:00.000Z');
  });

  it('updates `changed` count when remote updatedAt differs', async () => {
    const adapter = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();

    adapter.setPrs([makePr('1', '2026-05-29T01:00:00.000Z', 'new title')]);
    const r = await poller.tick();
    expect(r).toMatchObject({ fetched: 1, changed: 1, added: 0 });
    const stored = (await listStoredPullRequests(store))[0]!;
    expect(stored.title).toBe('new title');
  });

  it('isolates errors per connection: failure in one does not block others', async () => {
    const ok = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const broken = new FakeAdapter();
    broken.failNextList();
    const poller = new Poller({
      connections: [
        { connectionId: 'good', adapter: ok },
        { connectionId: 'bad', adapter: broken },
      ],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    const r = await poller.tick();
    expect(r.errors).toBe(1);
    expect(r.fetched).toBe(1);
    const stored = await listStoredPullRequests(store);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.localId).toBe('good:1');
  });

  it('tick re-entrancy: a second tick while one is in flight returns immediately', async () => {
    let resolveList: ((v: PullRequest[]) => void) | undefined;
    const slow: PlatformAdapter = {
      kind: 'bitbucket-server',
      async ping() {
        return { ok: true };
      },
      listPendingPullRequests: () => new Promise<PullRequest[]>((r) => (resolveList = r)),
    };
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter: slow }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    const firstTick = poller.tick();
    // 让 firstTick 推进到 adapter.listPendingPullRequests 调用（穿过 stateStore.read 的真实 fs 读）
    await new Promise<void>((r) => setTimeout(r, 50));
    const secondTick = await poller.tick(); // 立即返回 EMPTY
    expect(secondTick).toEqual({ fetched: 0, changed: 0, added: 0, errors: 0 });
    resolveList!([makePr('1', '2026-05-28T01:00:00.000Z')]);
    await firstTick;
    expect(await listStoredPullRequests(store)).toHaveLength(1);
  });

  it('writes a valid PullRequestsIndexFile with schema_version', async () => {
    const adapter = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    const file = await store.read<PullRequestsIndexFile>(PR_INDEX_KEY);
    expect(file?.schema_version).toBe(1);
    expect(file?.pull_requests).toHaveLength(1);
  });
});

describe('setLocalStatus', () => {
  it('updates an existing PR and returns it', async () => {
    const adapter = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    const updated = await setLocalStatus(store, 'bb1:1', 'reviewed');
    expect(updated?.localStatus).toBe('reviewed');
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('reviewed');
  });

  it('returns null for an unknown localId', async () => {
    const adapter = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    const updated = await setLocalStatus(store, 'bb1:nope', 'skipped');
    expect(updated).toBeNull();
  });

  it('returns null when the index file does not exist yet', async () => {
    const updated = await setLocalStatus(store, 'bb1:1', 'skipped');
    expect(updated).toBeNull();
  });
});
