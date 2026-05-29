import type { Logger } from 'pino';
import type {
  LocalPrStatus,
  PlatformAdapter,
  PollResult,
  StoredPullRequest,
} from '@pr-pilot/shared';
import type { StateStore } from '@pr-pilot/state-store';
import { PR_INDEX_KEY, type PullRequestsIndexFile } from './types.js';

export interface PollerConnection {
  connectionId: string;
  adapter: PlatformAdapter;
}

export interface PollerOptions {
  connections: ReadonlyArray<PollerConnection>;
  stateStore: StateStore;
  intervalSeconds: number;
  logger: Logger;
  /** 用于测试注入；默认 Date.now() */
  now?: () => Date;
}

const EMPTY: PollResult = { fetched: 0, changed: 0, added: 0, removed: 0, errors: 0 };

/**
 * 周期性 poll，把跨连接发现的 PR 汇入 `state/pull-requests.json`。
 *
 * 写入策略：保留旧 PR 的 localStatus 与 discoveredAt；每轮重写整文件
 * （单写者 + 原子写，规模小时简单胜过 diff 合并）。
 *
 * 并发：同一 tick 不重入。
 */
export class Poller {
  private interval?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(private readonly opts: PollerOptions) {}

  start(): void {
    if (this.interval) return;
    void this.tick();
    this.interval = setInterval(() => void this.tick(), this.opts.intervalSeconds * 1000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  /**
   * 立刻发起一次 poll；如果上一次还在跑就跳过本次。
   */
  async tick(): Promise<PollResult> {
    if (this.inFlight) return EMPTY;
    this.inFlight = true;
    try {
      return await this.pollOnce();
    } finally {
      this.inFlight = false;
    }
  }

  private async pollOnce(): Promise<PollResult> {
    const now = (this.opts.now?.() ?? new Date()).toISOString();
    const existing =
      (await this.opts.stateStore.read<PullRequestsIndexFile>(PR_INDEX_KEY))?.pull_requests ?? [];
    const byLocalId = new Map(existing.map((pr) => [pr.localId, pr]));

    let fetched = 0;
    let changed = 0;
    let added = 0;
    let removed = 0;
    let errors = 0;

    // 每个连接成功 poll 后看到的 localId 集合。用于剪除"远端消失的"PR
    // （merged / declined / 我不再是 reviewer）。失败的连接不进入此 map，
    // 避免一次性网络故障误删本地状态。
    const seenByConnection = new Map<string, Set<string>>();

    for (const { connectionId, adapter } of this.opts.connections) {
      const me = adapter.getCurrentUser();
      try {
        const remote = await adapter.listPendingPullRequests();
        fetched += remote.length;
        const seen = new Set<string>();
        seenByConnection.set(connectionId, seen);

        for (const pr of remote) {
          const localId = `${connectionId}:${pr.remoteId}`;
          seen.add(localId);
          const prev = byLocalId.get(localId);
          const approvedByMe =
            !!me && pr.reviewers.some((r) => r.name === me.name && r.approved);

          let localStatus: LocalPrStatus;
          if (prev) {
            if (prev.updatedAt !== pr.updatedAt) changed++;
            localStatus = prev.localStatus;
            // 冲突 ↔ ignored 双向自动迁移（只在 pending ↔ ignored 之间生效，
            // 不影响用户手动 skipped / reviewed 决定）
            if (pr.hasConflict && !prev.hasConflict && localStatus === 'pending') {
              localStatus = 'ignored';
            } else if (!pr.hasConflict && prev.hasConflict && localStatus === 'ignored') {
              localStatus = 'pending';
            }
            // approved 单向升 reviewed，优先级最高（即使冲突已批准也算 reviewed）
            if (approvedByMe && localStatus !== 'reviewed') {
              localStatus = 'reviewed';
            }
          } else {
            added++;
            // 优先级：approved > conflict > 默认 pending
            if (approvedByMe) localStatus = 'reviewed';
            else if (pr.hasConflict) localStatus = 'ignored';
            else localStatus = 'pending';
          }

          byLocalId.set(localId, {
            ...pr,
            localId,
            connectionId,
            localStatus,
            discoveredAt: prev?.discoveredAt ?? now,
            lastSeenAt: now,
          });
        }
      } catch (err) {
        errors++;
        this.opts.logger.error({ err, connectionId }, 'poll failed for connection');
      }
    }

    // 剪除：每个成功 poll 的连接，把"本地有 + 本轮没看到"的 PR 移除。
    // 该 PR 在远端要么已 merge/decline 关单，要么当前用户已不在 reviewer 列表。
    for (const [connectionId, seen] of seenByConnection) {
      for (const [localId, pr] of byLocalId) {
        if (pr.connectionId === connectionId && !seen.has(localId)) {
          byLocalId.delete(localId);
          removed++;
        }
      }
    }

    const next: PullRequestsIndexFile = {
      schema_version: 1,
      pull_requests: Array.from(byLocalId.values()),
    };
    await this.opts.stateStore.write(PR_INDEX_KEY, next);

    const result: PollResult = { fetched, changed, added, removed, errors };
    this.opts.logger.info(result, 'poll complete');
    return result;
  }
}

/** 修改某 PR 的本地状态（skipped / reviewed），不影响远端字段。 */
export async function setLocalStatus(
  stateStore: StateStore,
  localId: string,
  localStatus: LocalPrStatus,
): Promise<StoredPullRequest | null> {
  const file = await stateStore.read<PullRequestsIndexFile>(PR_INDEX_KEY);
  if (!file) return null;
  const pr = file.pull_requests.find((p) => p.localId === localId);
  if (!pr) return null;
  pr.localStatus = localStatus;
  await stateStore.write(PR_INDEX_KEY, file);
  return pr;
}

/** 读取 PR 列表（不存在时返回空数组）。 */
export async function listStoredPullRequests(stateStore: StateStore): Promise<StoredPullRequest[]> {
  const file = await stateStore.read<PullRequestsIndexFile>(PR_INDEX_KEY);
  return file?.pull_requests ?? [];
}
