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
  private currentUser: { name: string; displayName: string } | null = null;
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
  setCurrentUser(name: string, displayName = name): void {
    this.currentUser = { name, displayName };
  }
  getCurrentUser() {
    return this.currentUser;
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
  async getCloneUrl(): Promise<string> {
    return 'https://fake.example.com/repo.git';
  }
  async listPullRequestComments(): Promise<never[]> {
    return [];
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
    hasConflict: false,
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
    expect(r).toEqual({ fetched: 1, changed: 0, added: 1, removed: 0, errors: 0 });

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
    expect(r).toEqual({ fetched: 1, changed: 0, added: 0, removed: 0, errors: 0 });

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
      getCurrentUser: () => null,
      async getCloneUrl() {
        return 'https://stub';
      },
      async listPullRequestComments() {
        return [];
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
    expect(secondTick).toEqual({ fetched: 0, changed: 0, added: 0, removed: 0, errors: 0 });
    resolveList!([makePr('1', '2026-05-28T01:00:00.000Z')]);
    await firstTick;
    expect(await listStoredPullRequests(store)).toHaveLength(1);
  });

  it('prunes PRs that disappear from a successful poll (merged / declined remotely)', async () => {
    const adapter = new FakeAdapter([
      makePr('1', '2026-05-28T01:00:00.000Z'),
      makePr('2', '2026-05-28T02:00:00.000Z'),
    ]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    expect(await listStoredPullRequests(store)).toHaveLength(2);

    // PR #2 在远端 merged → 不再出现在 dashboard
    adapter.setPrs([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const r = await poller.tick();
    expect(r.removed).toBe(1);
    const stored = await listStoredPullRequests(store);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.localId).toBe('bb1:1');
  });

  it('does NOT prune PRs from a connection whose poll failed', async () => {
    const adapter = new FakeAdapter([
      makePr('1', '2026-05-28T01:00:00.000Z'),
      makePr('2', '2026-05-28T02:00:00.000Z'),
    ]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    expect(await listStoredPullRequests(store)).toHaveLength(2);

    // 下一次 poll 失败（网络抖动 / 远端 5xx）→ 本地状态库不动
    adapter.failNextList();
    const r = await poller.tick();
    expect(r.errors).toBe(1);
    expect(r.removed).toBe(0);
    expect(await listStoredPullRequests(store)).toHaveLength(2);
  });

  it('prune is per-connection: a failed connection does not block prune for healthy ones', async () => {
    const ok = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const broken = new FakeAdapter([makePr('a', '2026-05-28T01:00:00.000Z')]);
    const poller = new Poller({
      connections: [
        { connectionId: 'ok', adapter: ok },
        { connectionId: 'broken', adapter: broken },
      ],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    expect(await listStoredPullRequests(store)).toHaveLength(2);

    // ok 连接成功但其 PR 远端关单；broken 连接 fail
    ok.setPrs([]);
    broken.failNextList();
    const r = await poller.tick();
    expect(r.removed).toBe(1); // 只剪了 ok 的
    expect(r.errors).toBe(1);
    const stored = await listStoredPullRequests(store);
    expect(stored.map((p) => p.localId).sort()).toEqual(['broken:a']);
  });

  it('auto-marks new PR with hasConflict as ignored', async () => {
    const pr = makePr('1', '2026-05-28T01:00:00.000Z');
    pr.hasConflict = true;
    const adapter = new FakeAdapter([pr]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('ignored');
  });

  it('pending PR newly conflicted: upgrades to ignored on next poll', async () => {
    const pr = makePr('1', '2026-05-28T01:00:00.000Z');
    const adapter = new FakeAdapter([pr]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('pending');

    adapter.setPrs([{ ...pr, hasConflict: true }]);
    await poller.tick();
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('ignored');
  });

  it('ignored PR with conflict resolved: auto-reverts to pending', async () => {
    const pr = makePr('1', '2026-05-28T01:00:00.000Z');
    pr.hasConflict = true;
    const adapter = new FakeAdapter([pr]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('ignored');

    adapter.setPrs([{ ...pr, hasConflict: false }]);
    await poller.tick();
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('pending');
  });

  it('skipped PR newly conflicted: stays skipped (manual decision preserved)', async () => {
    const pr = makePr('1', '2026-05-28T01:00:00.000Z');
    const adapter = new FakeAdapter([pr]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    await setLocalStatus(store, 'bb1:1', 'skipped');

    adapter.setPrs([{ ...pr, hasConflict: true }]);
    await poller.tick();
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('skipped');
  });

  it('reviewed PR newly conflicted: stays reviewed', async () => {
    const pr = makePr('1', '2026-05-28T01:00:00.000Z');
    const adapter = new FakeAdapter([pr]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    await setLocalStatus(store, 'bb1:1', 'reviewed');

    adapter.setPrs([{ ...pr, hasConflict: true }]);
    await poller.tick();
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('reviewed');
  });

  it('new PR with conflict + approved: approved wins (reviewed)', async () => {
    const pr = makePr('1', '2026-05-28T01:00:00.000Z');
    pr.hasConflict = true;
    pr.reviewers = [{ name: 'kyle', displayName: 'Kyle', status: 'approved' as const }];
    const adapter = new FakeAdapter([pr]);
    adapter.setCurrentUser('kyle');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('reviewed');
  });

  it('auto-marks new PR as reviewed when current user is an approved reviewer', async () => {
    const pr = makePr('1', '2026-05-28T01:00:00.000Z');
    pr.reviewers = [
      { name: 'kyle', displayName: 'Kyle', status: 'approved' as const },
      { name: 'other', displayName: 'Other', status: 'unapproved' as const },
    ];
    const adapter = new FakeAdapter([pr]);
    adapter.setCurrentUser('kyle', 'Kyle');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    const stored = (await listStoredPullRequests(store))[0]!;
    expect(stored.localStatus).toBe('reviewed');
  });

  it('upgrades existing pending PR to reviewed when current user just approved', async () => {
    const pr = makePr('1', '2026-05-28T01:00:00.000Z');
    pr.reviewers = [{ name: 'kyle', displayName: 'Kyle', status: 'unapproved' as const }];
    const adapter = new FakeAdapter([pr]);
    adapter.setCurrentUser('kyle');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('pending');

    // Remote 端 kyle 在 BBS 上点了 approve
    adapter.setPrs([
      {
        ...pr,
        reviewers: [{ name: 'kyle', displayName: 'Kyle', status: 'approved' as const }],
      },
    ]);
    await poller.tick();
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('reviewed');
  });

  it('upgrades skipped PR to reviewed when later approved on remote', async () => {
    const pr = makePr('1', '2026-05-28T01:00:00.000Z');
    pr.reviewers = [{ name: 'kyle', displayName: 'Kyle', status: 'unapproved' as const }];
    const adapter = new FakeAdapter([pr]);
    adapter.setCurrentUser('kyle');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    await setLocalStatus(store, 'bb1:1', 'skipped');

    adapter.setPrs([
      { ...pr, reviewers: [{ name: 'kyle', displayName: 'Kyle', status: 'approved' as const }] },
    ]);
    await poller.tick();
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('reviewed');
  });

  it('does not flip reviewed back to pending if remote approval is later revoked', async () => {
    const pr = makePr('1', '2026-05-28T01:00:00.000Z');
    pr.reviewers = [{ name: 'kyle', displayName: 'Kyle', status: 'approved' as const }];
    const adapter = new FakeAdapter([pr]);
    adapter.setCurrentUser('kyle');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('reviewed');

    adapter.setPrs([
      { ...pr, reviewers: [{ name: 'kyle', displayName: 'Kyle', status: 'unapproved' as const }] },
    ]);
    await poller.tick();
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('reviewed');
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
