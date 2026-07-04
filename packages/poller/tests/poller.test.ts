import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from 'pino';
import { JsonFileStateStore } from '@meebox/state-store';
import type { PollNotificationEvent, PrComment, PullRequest } from '@meebox/shared';
import type {
  PlatformAdapter,
  PlatformConnection,
  PullRequestService,
  CommentService,
  MediaService,
} from '@meebox/platform-core';
import { Poller } from '../src/poller.js';
import { prHashId } from '../src/pr-hash-id.js';
import {
  PR_INDEX_KEY,
  listStoredPullRequests,
  setLocalStatus,
  type PrIndexFile,
} from '../src/pr-state.js';

// stubs for domain methods called only at the IPC layer and not triggered by the poller; satisfies the container interface contract.
const unusedComments: CommentService = {
  listPullRequestComments: async () => [],
  publishSummaryComment: () =>
    Promise.reject(new Error('FakeAdapter.publishSummaryComment 未实现（poller 测试不使用）')),
  publishInlineComment: () =>
    Promise.reject(new Error('FakeAdapter.publishInlineComment 未实现（poller 测试不使用）')),
  replyToComment: () =>
    Promise.reject(new Error('FakeAdapter.replyToComment 未实现（poller 测试不使用）')),
  editComment: () =>
    Promise.reject(new Error('FakeAdapter.editComment 未实现（poller 测试不使用）')),
  deleteComment: () =>
    Promise.reject(new Error('FakeAdapter.deleteComment 未实现（poller 测试不使用）')),
  toggleReaction: () =>
    Promise.reject(new Error('FakeAdapter.toggleReaction 未实现（poller 测试不使用）')),
};
const unusedMedia: MediaService = {
  getUserAvatar: async () => null,
  getAttachment: () =>
    Promise.reject(new Error('FakeAdapter.getAttachment 未实现（poller 测试不使用）')),
  uploadAttachment: async () => null,
};

/**
 * Container-shaped test double: the poller only reads kind / connection.getCurrentUser /
 * connection.capabilities / prs.listPendingPullRequests; other domains get minimal stubs.
 * The real test logic (user, capabilities, pending-PR behavior) lives in the corresponding sub-objects;
 * test helpers (setPrs / failNextList / seedUser) still hang on the adapter, and the sub-object closures read the same instance state.
 */
class FakeAdapter implements PlatformAdapter {
  readonly kind = 'bitbucket-server' as const;
  private currentUser: { name: string; displayName: string } | null = null;
  private commentList: PrComment[] = [];
  // capability switch: simulates a "reply-inclusive count signal" platform (GitHub/GitLab); defaults to false (Bitbucket coarse signal, fallback scan every round).
  private replyAware = false;
  // listPullRequestComments call count: verifies a reliable platform does not scan when unchanged / a coarse platform scans every round.
  commentCalls = 0;
  readonly connection: PlatformConnection;
  readonly prs: PullRequestService;
  readonly comments: CommentService = {
    ...unusedComments,
    listPullRequestComments: async () => {
      this.commentCalls += 1;
      return this.commentList;
    },
  };
  readonly media: MediaService = unusedMedia;

  constructor(
    private prList: PullRequest[] = [],
    private failPing = false,
    private failList = false,
  ) {
    this.connection = {
      kind: 'bitbucket-server',
      getCurrentUser: () => this.currentUser,
      capabilities: () => ({
        reviewStatuses: ['approved', 'needsWork', 'unapproved'] as const,
        inlineComments: true,
        inlineMultiline: true,
        commentOptimisticLock: true,
        commentReactions: 'free' as const,
        commentAttachments: true,
        commentHardBreaks: true,
        mergeVetoFidelity: 'full' as const,
        discoveryRateLimited: false,
        resolvableThreads: false,
        suggestions: false,
        reviewGrouping: false,
        activityTimeline: true,
        commentCountIncludesReplies: this.replyAware,
      }),
      ping: async () => {
        if (this.failPing) throw new Error('ping fail');
        return { ok: true, serverVersion: 'fake' };
      },
      getCloneUrl: async () => 'https://fake.example.com/repo.git',
    };
    this.prs = {
      listPendingPullRequests: async (): Promise<PullRequest[]> => {
        if (this.failList) {
          this.failList = false;
          throw new Error('list fail');
        }
        return this.prList;
      },
      getSinglePullRequest: () =>
        Promise.reject(new Error('FakeAdapter.getSinglePullRequest 未实现（poller 测试不使用）')),
      listPullRequestCommits: async () => [],
      listPullRequestActivity: async () => [],
      setPullRequestReviewStatus: async () => {
        // the test only cares about the poller's own behavior; setReviewStatus is called at the IPC layer, not triggered by the poller
      },
      mergePullRequest: () =>
        Promise.reject(new Error('FakeAdapter.mergePullRequest 未实现（poller 测试不使用）')),
    };
  }
  setPrs(prs: PullRequest[]): void {
    this.prList = prs;
  }
  failNextList(): void {
    this.failList = true;
  }
  // test helper: directly seed the current user (distinct from PlatformConnection's setCurrentUser(user) contract method).
  seedUser(name: string, displayName = name): void {
    this.currentUser = { name, displayName };
  }
  // test helper: seed the comments returned by listPullRequestComments (for unread mention / notification projection).
  seedComments(list: PrComment[]): void {
    this.commentList = list;
  }
  // test helper: switch to "reply-inclusive count signal" platform semantics (GitHub/GitLab); defaults to false to simulate Bitbucket coarse signal.
  setReplyAware(v: boolean): void {
    this.replyAware = v;
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
    mergeStatus: { canMerge: true, conflicted: false, vetoes: [] },
    hasConflict: false,
  };
}

/** "authored by me" PR: author is the current user (defaults to alice). Used for authored_* notification tests. */
function makeAuthoredPr(id: string, updatedAt: string, author = 'alice'): PullRequest {
  const pr = makePr(id, updatedAt);
  pr.author = { name: author, displayName: author };
  return pr;
}

let tmpDir: string;
let store: JsonFileStateStore;
// archive cold storage: physically separate from store (store root = tmpDir, archived root = tmpDir/archived).
let archiveStore: JsonFileStateStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meebox-poller-test-'));
  store = new JsonFileStateStore(tmpDir);
  archiveStore = new JsonFileStateStore(path.join(tmpDir, 'archived'));
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
      archiveStore,
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
    adapter.seedUser('kyle');
    let now = new Date('2026-06-01T00:00:00.000Z');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      archiveStore,
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
      archiveStore,
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
      archiveStore,
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

  it('tick re-entrancy: a second tick while one is in flight returns immediately (and registers a catch-up run)', async () => {
    let resolveList: ((v: PullRequest[]) => void) | undefined;
    let listCalls = 0;
    const slowConnection: PlatformConnection = {
      kind: 'bitbucket-server',
      capabilities: () => ({
        reviewStatuses: ['approved', 'needsWork', 'unapproved'],
        inlineComments: true,
        inlineMultiline: true,
        commentOptimisticLock: true,
        commentReactions: 'free',
        commentAttachments: true,
        commentHardBreaks: true,
        mergeVetoFidelity: 'full',
        discoveryRateLimited: false,
        resolvableThreads: false,
        suggestions: false,
        reviewGrouping: false,
        activityTimeline: true,
        commentCountIncludesReplies: false,
      }),
      ping: async () => ({ ok: true }),
      getCurrentUser: () => null,
      getCloneUrl: async () => 'https://stub',
    };
    const slowPulls: PullRequestService = {
      getSinglePullRequest: () => Promise.reject(new Error('unused')),
      listPullRequestCommits: async () => [],
      listPullRequestActivity: async () => [],
      setPullRequestReviewStatus: async () => {
        // unused in this test
      },
      mergePullRequest: () => Promise.reject(new Error('unused')),
      // the first call returns a pending promise controlled by resolveList; subsequent ones (the
      // "catch-up run" registered by the second tick during in-flight) return immediately to avoid a hung test.
      // the catch-up run is new semantics: although the second tick returns EMPTY immediately, right after the current
      // round ends it polls one more round (ensures the reclassification request after ping asynchronously fills currentUser is not lost).
      listPendingPullRequests: () => {
        listCalls += 1;
        return listCalls === 1
          ? new Promise<PullRequest[]>((r) => (resolveList = r))
          : Promise.resolve([makePr('1', '2026-05-28T01:00:00.000Z')]);
      },
    };
    const slow: PlatformAdapter = {
      kind: 'bitbucket-server',
      connection: slowConnection,
      prs: slowPulls,
      // the following domains are not triggered by this test; minimal stubs satisfy the container interface contract.
      comments: {
        listPullRequestComments: async () => [],
        publishSummaryComment: () => Promise.reject(new Error('unused')),
        publishInlineComment: () => Promise.reject(new Error('unused')),
        replyToComment: () => Promise.reject(new Error('unused')),
        editComment: () => Promise.reject(new Error('unused')),
        deleteComment: () => Promise.reject(new Error('unused')),
        toggleReaction: () => Promise.reject(new Error('unused')),
      },
      media: {
        getUserAvatar: async () => null,
        getAttachment: () => Promise.reject(new Error('unused')),
        uploadAttachment: async () => null,
      },
    };
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter: slow }],
      stateStore: store,
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    const firstTick = poller.tick();
    // let firstTick advance to the adapter.listPendingPullRequests call (through the real fs read of stateStore.read)
    await new Promise<void>((r) => setTimeout(r, 50));
    const secondTick = await poller.tick(); // returns EMPTY immediately
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
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    expect(await listStoredPullRequests(store)).toHaveLength(2);

    // PR #2 merged remotely → no longer appears in the dashboard
    adapter.setPrs([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const r = await poller.tick();
    expect(r.removed).toBe(1);
    const stored = await listStoredPullRequests(store);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.remoteId).toBe('1');
  });

  it('all connections fail in one tick: index file mtime untouched + state intact', async () => {
    // first a successful poll to lay down the baseline
    const ok1 = makePr('1', '2026-05-28T01:00:00.000Z');
    const ok2 = makePr('2', '2026-05-28T02:00:00.000Z');
    const adapter = new FakeAdapter([ok1, ok2]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    const indexPath = path.join(tmpDir, 'prs', 'index.json');
    const mtimeBefore = (await fs.stat(indexPath)).mtimeMs;
    const storedBefore = await listStoredPullRequests(store);

    // next round: remote fails as a whole (network down / 5xx) → not a single local row moves (invariant #1+#2)
    adapter.failNextList();
    // add at least a 5ms time window to avoid mtime resolution (Windows NTFS 100ns would do, just to be safe)
    await new Promise<void>((r) => setTimeout(r, 5));
    const r = await poller.tick();
    expect(r.errors).toBe(1);
    expect(r.removed).toBe(0);
    expect(r.changed).toBe(0);
    expect(r.added).toBe(0);
    const mtimeAfter = (await fs.stat(indexPath)).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore); // file was not rewritten
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
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    expect(await listStoredPullRequests(store)).toHaveLength(2);

    // next poll fails (network jitter / remote 5xx) → local state store untouched
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
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    expect(await listStoredPullRequests(store)).toHaveLength(2);

    // ok connection succeeds but its PR is closed remotely; broken connection fails
    ok.setPrs([]);
    broken.failNextList();
    const r = await poller.tick();
    expect(r.removed).toBe(1); // only ok's was pruned
    expect(r.errors).toBe(1);
    const stored = await listStoredPullRequests(store);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.connectionId).toBe('broken');
  });

  // localStatus directly mirrors Bitbucket reviewer.status; it is a local cache of the remote authoritative state.
  // hasConflict does not affect localStatus (it is only an independent dimension; the UI filters by hasConflict separately).

  it('preserves hasConflict=true on new PR without changing localStatus', async () => {
    const pr = makePr('1', '2026-05-28T01:00:00.000Z');
    pr.hasConflict = true;
    const adapter = new FakeAdapter([pr]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      archiveStore,
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
    adapter.seedUser('kyle', 'Kyle');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      archiveStore,
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
    adapter.seedUser('kyle');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      archiveStore,
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
    adapter.seedUser('kyle');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('pending');

    // kyle clicked approve on Bitbucket
    adapter.setPrs([
      { ...pr, reviewers: [{ name: 'kyle', displayName: 'Kyle', status: 'approved' as const }] },
    ]);
    await poller.tick();
    expect((await listStoredPullRequests(store))[0]!.localStatus).toBe('approved');

    // kyle revoked on Bitbucket, back to pending
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
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    const file = await store.read<PrIndexFile>(PR_INDEX_KEY);
    expect(file?.schema_version).toBe(1);
    expect(Object.keys(file!.prs)).toHaveLength(1);
    // each PR's meta.json lands at prs/<hash>/meta.json
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
      archiveStore,
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
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    expect(await listStoredPullRequests(store)).toHaveLength(2);
    const goneHash = (await listStoredPullRequests(store)).find((p) => p.remoteId === '2')!.localId;

    // PR #2 closed → soft archive (archivedAt set in index), list filters it out automatically
    adapter.setPrs([makePr('1', '2026-05-28T01:00:00.000Z')]);
    await poller.tick();
    const visible = await listStoredPullRequests(store);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.remoteId).toBe('1');

    // index entry still present (hard-deleted only after grace period expires); data already moved from active storage into archive cold storage
    const index = await store.read<PrIndexFile>(PR_INDEX_KEY);
    const archivedEntries = Object.values(index!.prs).filter((e) => e.archivedAt);
    expect(archivedEntries).toHaveLength(1);
    expect(await store.read(`prs/${goneHash}/meta`)).toBeNull(); // active storage already emptied
    expect(await archiveStore.read(`prs/${goneHash}/meta`)).not.toBeNull(); // landed in archive storage
  });

  it('archived PR re-appearing on remote becomes active again', async () => {
    const adapter = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    const hash = (await listStoredPullRequests(store))[0]!.localId;

    // closed remotely → soft archive: data moved into archive storage
    adapter.setPrs([]);
    await poller.tick();
    expect(await listStoredPullRequests(store)).toHaveLength(0);
    expect(await archiveStore.read(`prs/${hash}/meta`)).not.toBeNull();

    // revival: reappears remotely (e.g. reviewer re-added) → archivedAt cleared, whole tree moved back to active storage
    adapter.setPrs([makePr('1', '2026-05-28T01:00:00.000Z')]);
    await poller.tick();
    expect(await listStoredPullRequests(store)).toHaveLength(1);
    expect(await store.read(`prs/${hash}/meta`)).not.toBeNull(); // moved back to active storage
    expect(await archiveStore.read(`prs/${hash}/meta`)).toBeNull(); // archive storage now vacated
  });

  it('external deletion of prs/index.json: next poll rebuilds automatically', async () => {
    const adapter = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    expect(await listStoredPullRequests(store)).toHaveLength(1);

    // simulate an external party (user / cleanup tool) directly rm-ing the index file
    await fs.rm(path.join(tmpDir, 'prs', 'index.json'));
    expect(await listStoredPullRequests(store)).toHaveLength(0);

    // next poll rebuilds the index
    await poller.tick();
    expect(await listStoredPullRequests(store)).toHaveLength(1);
  });

  it('external deletion of meta.json but index still present: list skips; next poll rewrites meta', async () => {
    const adapter = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
    });
    await poller.tick();
    const hash = (await listStoredPullRequests(store))[0]!.localId;
    const metaPath = path.join(tmpDir, 'prs', hash, 'meta.json');

    // external party clears meta; the index entry remains
    await fs.rm(metaPath);
    expect(await listStoredPullRequests(store)).toHaveLength(0); // list skips

    // next poll: the PR is still on remote → writes meta back
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
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
      now: () => now,
    });
    await poller.tick();
    const hash = (await listStoredPullRequests(store))[0]!.localId;

    // T+0: closed → soft archive: data moved into archive storage (still retained within grace period)
    adapter.setPrs([]);
    await poller.tick();
    expect(await archiveStore.read(`prs/${hash}/meta`)).not.toBeNull();

    // T+8 days: past the 1-week grace → hard-purge the whole directory (cleared on both archive storage + active storage)
    now = new Date('2026-06-09T00:00:00.000Z');
    await poller.tick();
    expect(await archiveStore.read(`prs/${hash}/meta`)).toBeNull();
    expect(await store.read(`prs/${hash}/meta`)).toBeNull();
    const index = await store.read<PrIndexFile>(PR_INDEX_KEY);
    expect(Object.keys(index!.prs)).toHaveLength(0);
  });

  it('reconciliation: move archived data stuck in active storage into archive storage (old layout / split-brain eventual consistency)', async () => {
    const adapter = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const now = new Date('2026-06-01T00:00:00.000Z');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
      now: () => now,
    });
    await poller.tick();
    const hash = (await listStoredPullRequests(store))[0]!.localId;

    // simulate old-layout leftovers: manually mark the index entry archived, but the data **still stays in active storage** (not migrated)
    const index = await store.read<PrIndexFile>(PR_INDEX_KEY);
    index!.prs[hash]!.archivedAt = now.toISOString();
    await store.write(PR_INDEX_KEY, index!);
    expect(await store.read(`prs/${hash}/meta`)).not.toBeNull();
    expect(await archiveStore.read(`prs/${hash}/meta`)).toBeNull();

    // the PR still absent from remote → the reconciliation step of the next poll (before grace, no purge) moves the whole tree into archive storage
    adapter.setPrs([]);
    await poller.tick();
    expect(await store.read(`prs/${hash}/meta`)).toBeNull(); // moved out of active storage
    expect(await archiveStore.read(`prs/${hash}/meta`)).not.toBeNull(); // landed in archive storage
    // still in the index, still archived (reconciliation only moves data, does not touch the index)
    const after = await store.read<PrIndexFile>(PR_INDEX_KEY);
    expect(after!.prs[hash]!.archivedAt).toBe(now.toISOString());
  });
});

describe('setLocalStatus', () => {
  it('updates an existing PR and returns it', async () => {
    const adapter = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      archiveStore,
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
      archiveStore,
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

describe('Poller.archiveConnectionsExcept', () => {
  it('archives PRs of inactive connections, keeps the active connection (enters the purge path)', async () => {
    const a1 = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    const a2 = new FakeAdapter([makePr('2', '2026-05-28T01:00:00.000Z')]);
    const now = new Date('2026-06-01T00:00:00.000Z');
    const poller = new Poller({
      connections: [
        { connectionId: 'bb1', adapter: a1 },
        { connectionId: 'bb2', adapter: a2 },
      ],
      stateStore: store,
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
      now: () => now,
    });
    await poller.tick(); // PRs from both connections are stored, archivedAt=null

    // user switches: only bb1 remains active
    await poller.archiveConnectionsExcept(['bb1']);

    const index = await store.read<PrIndexFile>(PR_INDEX_KEY);
    const entries = Object.values(index!.prs);
    const bb1 = entries.find((e) => e.identity.connectionId === 'bb1')!;
    const bb2 = entries.find((e) => e.identity.connectionId === 'bb2')!;
    expect(bb1.archivedAt).toBeNull(); // active connection untouched
    expect(bb2.archivedAt).toBe(now.toISOString()); // inactive connection archived
    // bb1 data stays in active storage; bb2 data moved into archive storage
    const bb1Hash = Object.entries(index!.prs).find(([, e]) => e === bb1)![0];
    const bb2Hash = Object.entries(index!.prs).find(([, e]) => e === bb2)![0];
    expect(await store.read(`prs/${bb1Hash}/meta`)).not.toBeNull();
    expect(await store.read(`prs/${bb2Hash}/meta`)).toBeNull();
    expect(await archiveStore.read(`prs/${bb2Hash}/meta`)).not.toBeNull();

    // idempotent: calling again does not change the already-archived timestamp
    const later = new Date('2026-06-02T00:00:00.000Z');
    const poller2 = new Poller({
      connections: [{ connectionId: 'bb1', adapter: a1 }],
      stateStore: store,
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
      now: () => later,
    });
    await poller2.archiveConnectionsExcept(['bb1']);
    const index2 = await store.read<PrIndexFile>(PR_INDEX_KEY);
    const bb2After = Object.values(index2!.prs).find((e) => e.identity.connectionId === 'bb2')!;
    expect(bb2After.archivedAt).toBe(now.toISOString()); // still the first archive time
  });
});

function makeComment(over: Partial<PrComment> & Pick<PrComment, 'author' | 'body' | 'createdAt'>): PrComment {
  return { remoteId: 'c', updatedAt: over.createdAt, anchor: null, replies: [], ...over };
}

describe('Poller onNotify (system notification projection)', () => {
  it('emits no events on the first (baseline) poll, then new_pr + mention on later polls', async () => {
    const adapter = new FakeAdapter([makePr('1', '2026-05-28T01:00:00.000Z')]);
    adapter.seedUser('alice');
    const events: PollNotificationEvent[] = [];
    let now = new Date('2026-06-01T00:00:00.000Z');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
      now: () => now,
      onNotify: (e) => events.push(...e),
    });

    // first round: build the baseline, produce no events (avoids a first-launch flood).
    await poller.tick();
    expect(events).toEqual([]);

    // second round: PR1 content changed + one new @alice comment; a brand-new PR2 also arrives.
    now = new Date('2026-06-02T00:00:00.000Z');
    adapter.setPrs([
      makePr('1', '2026-05-29T01:00:00.000Z'),
      makePr('2', '2026-05-29T02:00:00.000Z'),
    ]);
    adapter.seedComments([
      makeComment({
        author: { name: 'bob', displayName: 'Bob' },
        body: 'please look @alice',
        createdAt: '2026-06-02T00:00:00.000Z',
      }),
    ]);
    await poller.tick();

    const kinds = events.map((e) => ({ kind: e.kind, remoteId: e.remoteId, count: e.count }));
    expect(kinds).toContainEqual({ kind: 'new_pr', remoteId: '2', count: undefined });
    expect(kinds).toContainEqual({ kind: 'mention', remoteId: '1', count: 1 });
    // only these two (PR2 is a new discovery, its own comments do not project a mention; PR1 has just one mention).
    expect(events).toHaveLength(2);

    // rich fields: repo + connection + actor (new_pr=PR author; mention=comment author) all projected together.
    const newPr = events.find((e) => e.kind === 'new_pr')!;
    expect(newPr.repo).toEqual({ projectKey: 'P', repoSlug: 'r' });
    expect(newPr.connectionId).toBe('bb1');
    expect(newPr.actor.name).toBe('u'); // makePr's author
    const mention = events.find((e) => e.kind === 'mention')!;
    expect(mention.actor.name).toBe('bob'); // comment author
    expect(mention.comment?.anchor).toBeNull(); // summary comment → click opens the activity tab
  });

  it('suppresses notifications for non-pending PRs (already approved / needs_work)', async () => {
    // PR1 already approved by the current user → localStatus is not pending; even a new @ comment does not pop a notification.
    const approved = makePr('1', '2026-05-28T01:00:00.000Z');
    approved.reviewers = [{ name: 'alice', displayName: 'Alice', status: 'approved' as const }];
    const adapter = new FakeAdapter([approved]);
    adapter.seedUser('alice');
    const events: PollNotificationEvent[] = [];
    let now = new Date('2026-06-01T00:00:00.000Z');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
      now: () => now,
      onNotify: (e) => events.push(...e),
    });

    await poller.tick(); // baseline
    now = new Date('2026-06-02T00:00:00.000Z');
    const changed = makePr('1', '2026-05-29T01:00:00.000Z');
    changed.reviewers = [{ name: 'alice', displayName: 'Alice', status: 'approved' as const }];
    adapter.setPrs([changed]);
    adapter.seedComments([
      makeComment({
        author: { name: 'bob', displayName: 'Bob' },
        body: 'ping @alice',
        createdAt: '2026-06-02T00:00:00.000Z',
      }),
    ]);
    await poller.tick();
    expect(events).toEqual([]); // not pending → not projected
  });

  it('coarse-signal platform (Bitbucket) catches a reply with no updatedAt / commentCount change', async () => {
    // core fix: a Bitbucket reply neither bumps updatedDate nor counts toward the top-level commentCount → only a fallback scan of pending PRs every round avoids missing it.
    const pr1 = makePr('1', '2026-05-28T01:00:00.000Z');
    pr1.commentCount = 5; // top-level comment count; adding a reply does not change it
    const adapter = new FakeAdapter([pr1]); // FakeAdapter defaults to commentCountIncludesReplies=false (coarse signal)
    adapter.seedUser('alice');
    const events: PollNotificationEvent[] = [];
    let now = new Date('2026-06-01T00:00:00.000Z');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
      now: () => now,
      onNotify: (e) => events.push(...e),
    });

    await poller.tick(); // baseline
    expect(events).toEqual([]);

    // second round: updatedAt and commentCount both unchanged, only a bob reply added under alice's comment.
    now = new Date('2026-06-02T00:00:00.000Z');
    adapter.setPrs([pr1]); // same PR, updatedAt / commentCount as-is
    adapter.seedComments([
      makeComment({
        author: { name: 'alice', displayName: 'Alice' }, // my top-level comment
        body: 'my comment',
        createdAt: '2026-05-28T02:00:00.000Z',
        replies: [
          makeComment({
            author: { name: 'bob', displayName: 'Bob' },
            body: 'replying to you',
            createdAt: '2026-06-02T00:00:00.000Z',
          }),
        ],
      }),
    ]);
    await poller.tick();

    const reply = events.find((e) => e.kind === 'reply');
    expect(reply).toBeDefined();
    expect(reply!.remoteId).toBe('1');
    expect(reply!.actor.name).toBe('bob');
  });

  it('reply-aware platform skips the comment fetch when neither updatedAt nor commentCount changed', async () => {
    const pr1 = makePr('1', '2026-05-28T01:00:00.000Z');
    pr1.commentCount = 0;
    const adapter = new FakeAdapter([pr1]);
    adapter.setReplyAware(true); // simulate GitHub/GitLab: reply-inclusive count signal
    adapter.seedUser('alice');
    const events: PollNotificationEvent[] = [];
    let now = new Date('2026-06-01T00:00:00.000Z');
    const poller = new Poller({
      connections: [{ connectionId: 'gh1', adapter }],
      stateStore: store,
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
      now: () => now,
      onNotify: (e) => events.push(...e),
    });

    await poller.tick(); // baseline: reliable platform does not scan on the baseline round
    expect(adapter.commentCalls).toBe(0);

    // second round: commentCount 0→1 (reply-inclusive signal changes) → scan once and project a mention (updatedAt intentionally unchanged, proving it triggers on the count).
    now = new Date('2026-06-02T00:00:00.000Z');
    const pr1b = makePr('1', '2026-05-28T01:00:00.000Z');
    pr1b.commentCount = 1;
    adapter.setPrs([pr1b]);
    adapter.seedComments([
      makeComment({
        author: { name: 'bob', displayName: 'Bob' },
        body: 'ping @alice',
        createdAt: '2026-06-02T00:00:00.000Z',
      }),
    ]);
    await poller.tick();
    expect(adapter.commentCalls).toBe(1); // count changed → scanned once
    expect(events.some((e) => e.kind === 'mention')).toBe(true);

    // third round: updatedAt and commentCount both unchanged → no more scans, no new events.
    now = new Date('2026-06-03T00:00:00.000Z');
    const pr1c = makePr('1', '2026-05-28T01:00:00.000Z');
    pr1c.commentCount = 1;
    adapter.setPrs([pr1c]);
    const eventsLen = events.length;
    await poller.tick();
    expect(adapter.commentCalls).toBe(1); // unchanged → not scanned
    expect(events.length).toBe(eventsLen); // no new events
  });

  it('authored PR: fires authored_needs_work when a reviewer newly marks needs-work', async () => {
    const adapter = new FakeAdapter([makeAuthoredPr('1', '2026-05-28T01:00:00.000Z')]);
    adapter.seedUser('alice');
    const events: PollNotificationEvent[] = [];
    let now = new Date('2026-06-01T00:00:00.000Z');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
      now: () => now,
      onNotify: (e) => events.push(...e),
    });

    await poller.tick(); // baseline: no needsWork reviewer
    expect(events).toEqual([]);

    now = new Date('2026-06-02T00:00:00.000Z');
    const changed = makeAuthoredPr('1', '2026-05-29T01:00:00.000Z');
    changed.reviewers = [{ name: 'bob', displayName: 'Bob', status: 'needsWork' as const }];
    adapter.setPrs([changed]);
    await poller.tick();

    const e = events.find((x) => x.kind === 'authored_needs_work');
    expect(e).toBeDefined();
    expect(e!.remoteId).toBe('1');
    expect(e!.actor.name).toBe('bob'); // the reviewer who marked needs-work
  });

  it('authored PR: fires authored_conflict on a false→true merge-conflict transition', async () => {
    const adapter = new FakeAdapter([makeAuthoredPr('1', '2026-05-28T01:00:00.000Z')]);
    adapter.seedUser('alice');
    const events: PollNotificationEvent[] = [];
    let now = new Date('2026-06-01T00:00:00.000Z');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
      now: () => now,
      onNotify: (e) => events.push(...e),
    });

    await poller.tick(); // baseline: no conflict
    expect(events).toEqual([]);

    now = new Date('2026-06-02T00:00:00.000Z');
    const conflicted = makeAuthoredPr('1', '2026-05-29T01:00:00.000Z');
    conflicted.hasConflict = true;
    conflicted.mergeStatus = { canMerge: false, conflicted: true, vetoes: [] };
    adapter.setPrs([conflicted]);
    await poller.tick();

    const e = events.find((x) => x.kind === 'authored_conflict');
    expect(e).toBeDefined();
    expect(e!.remoteId).toBe('1');
  });

  it('authored PR: seeds the comment cursor silently, then fires authored_comment on a later new comment', async () => {
    const adapter = new FakeAdapter([makeAuthoredPr('1', '2026-05-28T01:00:00.000Z')]);
    adapter.seedUser('alice');
    const events: PollNotificationEvent[] = [];
    let now = new Date('2026-06-01T00:00:00.000Z');
    const poller = new Poller({
      connections: [{ connectionId: 'bb1', adapter }],
      stateStore: store,
      archiveStore,
      intervalSeconds: 60,
      logger: noopLogger,
      now: () => now,
      onNotify: (e) => events.push(...e),
    });

    await poller.tick(); // baseline: first round is not notifiable, does not scan comments

    // second round: a comment from someone else appears → only seed the cursor, do not backfill historical comments.
    now = new Date('2026-06-02T00:00:00.000Z');
    adapter.setPrs([makeAuthoredPr('1', '2026-05-29T01:00:00.000Z')]);
    adapter.seedComments([
      makeComment({
        author: { name: 'bob', displayName: 'Bob' },
        body: 'looks good',
        createdAt: '2026-06-02T00:00:00.000Z',
      }),
    ]);
    await poller.tick();
    expect(events.some((e) => e.kind === 'authored_comment')).toBe(false);

    // third round: another later comment from someone else (after the cursor) → triggers authored_comment.
    now = new Date('2026-06-03T00:00:00.000Z');
    adapter.setPrs([makeAuthoredPr('1', '2026-05-30T01:00:00.000Z')]);
    adapter.seedComments([
      makeComment({
        author: { name: 'bob', displayName: 'Bob' },
        body: 'looks good',
        createdAt: '2026-06-02T00:00:00.000Z',
      }),
      makeComment({
        author: { name: 'bob', displayName: 'Bob' },
        body: 'one more thing',
        createdAt: '2026-06-03T00:00:00.000Z',
      }),
    ]);
    await poller.tick();

    const e = events.find((x) => x.kind === 'authored_comment');
    expect(e).toBeDefined();
    expect(e!.remoteId).toBe('1');
    expect(e!.count).toBe(1);
    expect(e!.actor.name).toBe('bob');
  });
});
