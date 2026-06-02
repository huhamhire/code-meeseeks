import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from 'pino';
import { JsonFileStateStore } from '@pr-pilot/state-store';
import type { PlatformAdapter, PullRequest } from '@pr-pilot/shared';
import { Poller } from '../src/poller.js';
import { prHashId } from '../src/pr-hash-id.js';
import {
  PR_INDEX_KEY,
  listStoredPullRequests,
  setLocalStatus,
  type PrIndexFile,
} from '../src/pr-state.js';

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
  async getUserAvatar(): Promise<null> {
    return null;
  }
  async setPullRequestReviewStatus(): Promise<void> {
    // 测试只关心 poller 自身行为；setReviewStatus 在 IPC 层调用，poller 不触发
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
    const expectedId = prHashId({
      platform: 'bitbucket-server',
      connectionId: 'bb1',
      group: 'P',
      repo: 'r',
      remoteId: '1',
    });
    expect(stored[0]).toMatchObject({
      localId: expectedId,
      connectionId: 'bb1',
      localStatus: 'pending',
      discoveredAt: fixedNow.toISOString(),
      lastSeenAt: fixedNow.toISOString(),
    });
  });

  it('second run with same PR: preserves discoveredAt, updates lastSeenAt, syncs status from remote', async () => {
    const pr = makePr('1', '2026-05-28T01:00:00.000Z');
    pr.reviewers = [{ name: 'kyle', displayName: 'Kyle', status: 'unapproved' as const }];
    const adapter = new FakeAdapter([pr]);
    adapter.setCurrentUser('kyle');
    let now = new Date('2026-06-01T00:00:00.000Z');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
      now: () => now,
    });

    await poller.tick();

    now = new Date('2026-06-02T00:00:00.000Z');
    const r = await poller.tick();
    expect(r).toEqual({ fetched: 1, changed: 0, added: 0, removed: 0, errors: 0 });

    const stored = (await listStoredPullRequests(store))[0]!;
    expect(stored.localStatus).toBe('pending');
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
    expect(stored[0]!.connectionId).toBe('good');
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
      async getUserAvatar() {
        return null;
      },
      async setPullRequestReviewStatus() {
        // unused in this test
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
    expect(stored[0]!.remoteId).toBe('1');
  });

  it('all connections fail in one tick: index file mtime untouched + state intact', async () => {
    // 先一次成功 poll，落地基线
    const ok1 = makePr('1', '2026-05-28T01:00:00.000Z');
    const ok2 = makePr('2', '2026-05-28T02:00:00.000Z');
    const adapter = new FakeAdapter([ok1, ok2]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    const indexPath = path.join(tmpDir, 'prs', 'index.json');
    const mtimeBefore = (await fs.stat(indexPath)).mtimeMs;
    const storedBefore = await listStoredPullRequests(store);

    // 下一轮：远端整体失败 (网络断 / 5xx) → 本地一行不动 (invariant #1+#2)
    adapter.failNextList();
    // 至少加 5ms 时间窗，避免 mtime 分辨率 (Windows NTFS 100ns 都行，保险起见)
    await new Promise<void>((r) => setTimeout(r, 5));
    const r = await poller.tick();
    expect(r.errors).toBe(1);
    expect(r.removed).toBe(0);
    expect(r.changed).toBe(0);
    expect(r.added).toBe(0);
    const mtimeAfter = (await fs.stat(indexPath)).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore); // 文件没被重写
    expect(await listStoredPullRequests(store)).toEqual(storedBefore);
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
    expect(stored).toHaveLength(1);
    expect(stored[0]!.connectionId).toBe('broken');
  });

  // localStatus 直接镜像 BBS reviewer.status，是远端权威态的本地缓存。
  // hasConflict 不影响 localStatus（仅作为独立维度，UI 通过 hasConflict 单独筛选）。

  it('preserves hasConflict=true on new PR without changing localStatus', async () => {
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
    const stored = (await listStoredPullRequests(store))[0]!;
    expect(stored.localStatus).toBe('pending');
    expect(stored.hasConflict).toBe(true);
  });

  it('maps reviewer.status=approved on current user to localStatus=approved', async () => {
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
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('approved');
  });

  it('maps reviewer.status=needsWork on current user to localStatus=needs_work', async () => {
    const pr = makePr('1', '2026-05-28T01:00:00.000Z');
    pr.reviewers = [{ name: 'kyle', displayName: 'Kyle', status: 'needsWork' as const }];
    const adapter = new FakeAdapter([pr]);
    adapter.setCurrentUser('kyle');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('needs_work');
  });

  it('reflects remote status changes on subsequent polls (approve → revoke)', async () => {
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

    // BBS 上 kyle 点了 approve
    adapter.setPrs([
      { ...pr, reviewers: [{ name: 'kyle', displayName: 'Kyle', status: 'approved' as const }] },
    ]);
    await poller.tick();
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('approved');

    // BBS 上 kyle 撤销，回到 pending
    adapter.setPrs([
      { ...pr, reviewers: [{ name: 'kyle', displayName: 'Kyle', status: 'unapproved' as const }] },
    ]);
    await poller.tick();
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('pending');
  });

  it('writes a valid prs/index.json with schema_version + per-PR meta', async () => {
    const adapter = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    const file = await store.read<PrIndexFile>(PR_INDEX_KEY);
    expect(file?.schema_version).toBe(1);
    expect(Object.keys(file!.prs)).toHaveLength(1);
    // 每个 PR 的 meta.json 落在 prs/<hash>/meta.json
    const hash = Object.keys(file!.prs)[0]!;
    const meta = await store.read<{ schema_version: 1; pr: { localId: string } }>(
      `prs/${hash}/meta`,
    );
    expect(meta?.pr.localId).toBe(hash);
  });

  it('different repos with same remoteId get distinct localIds (hash includes proj/repo)', async () => {
    const prRepoX = makePr('42', '2026-05-28T01:00:00.000Z');
    prRepoX.repo = { projectKey: 'A', repoSlug: 'x' };
    const prRepoY = makePr('42', '2026-05-28T02:00:00.000Z');
    prRepoY.repo = { projectKey: 'A', repoSlug: 'y' };
    const adapter = new FakeAdapter([prRepoX, prRepoY]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    const stored = await listStoredPullRequests(store);
    expect(stored).toHaveLength(2);
    expect(stored[0]!.localId).not.toBe(stored[1]!.localId);
  });

  it('PR gone from remote becomes soft-archived (filtered out of listStoredPullRequests)', async () => {
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

    // PR #2 关单 → soft archive (archivedAt set in index)，list 自动过滤掉
    adapter.setPrs([makePr('1', '2026-05-28T01:00:00.000Z')]);
    await poller.tick();
    const visible = await listStoredPullRequests(store);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.remoteId).toBe('1');

    // 但 meta.json + 索引条目仍在 (待 grace 期满才硬删)
    const index = await store.read<PrIndexFile>(PR_INDEX_KEY);
    const archivedEntries = Object.values(index!.prs).filter((e) => e.archivedAt);
    expect(archivedEntries).toHaveLength(1);
  });

  it('archived PR re-appearing on remote becomes active again', async () => {
    const adapter = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();

    // 远端关单 → soft archive
    adapter.setPrs([]);
    await poller.tick();
    expect(await listStoredPullRequests(store)).toHaveLength(0);

    // 复活：远端又出现 (例如 reviewer 被重新加回) → archivedAt 清零
    adapter.setPrs([makePr('1', '2026-05-28T01:00:00.000Z')]);
    await poller.tick();
    expect(await listStoredPullRequests(store)).toHaveLength(1);
  });

  it('外部删除 prs/index.json: 下一轮 poll 自动重建', async () => {
    const adapter = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    expect(await listStoredPullRequests(store)).toHaveLength(1);

    // 模拟外部 (用户 / 清理工具) 直接 rm 掉索引文件
    await fs.rm(path.join(tmpDir, 'prs', 'index.json'));
    expect(await listStoredPullRequests(store)).toHaveLength(0);

    // 下一轮 poll 重建索引
    await poller.tick();
    expect(await listStoredPullRequests(store)).toHaveLength(1);
  });

  it('外部删除 meta.json 但索引尚存：list 跳过；下一轮 poll 重写 meta', async () => {
    const adapter = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    const hash = (await listStoredPullRequests(store))[0]!.localId;
    const metaPath = path.join(tmpDir, 'prs', hash, 'meta.json');

    // 外部清掉 meta；索引 entry 仍在
    await fs.rm(metaPath);
    expect(await listStoredPullRequests(store)).toHaveLength(0); // list 跳过

    // 下一轮 poll：PR 还在远端 → 写回 meta
    await poller.tick();
    expect(await listStoredPullRequests(store)).toHaveLength(1);
    await expect(fs.access(metaPath)).resolves.toBeUndefined();
  });

  it('hard-purges archived PR after grace period expires', async () => {
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
    const hash = (await listStoredPullRequests(store))[0]!.localId;

    // T+0: 关单 → soft archive
    adapter.setPrs([]);
    await poller.tick();
    expect(await store.read(`prs/${hash}/meta`)).not.toBeNull();

    // T+8 天: 超过 1 周 grace → 硬清掉整目录
    now = new Date('2026-06-09T00:00:00.000Z');
    await poller.tick();
    expect(await store.read(`prs/${hash}/meta`)).toBeNull();
    const index = await store.read<PrIndexFile>(PR_INDEX_KEY);
    expect(Object.keys(index!.prs)).toHaveLength(0);
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
    const hash = (await listStoredPullRequests(store))[0]!.localId;
    const updated = await setLocalStatus(store, hash, 'approved');
    expect(updated?.localStatus).toBe('approved');
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('approved');
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
    const updated = await setLocalStatus(store, 'nonexistenthash', 'needs_work');
    expect(updated).toBeNull();
  });

  it('returns null when no meta file exists yet', async () => {
    const updated = await setLocalStatus(store, 'somehash12ab', 'needs_work');
    expect(updated).toBeNull();
  });
});
