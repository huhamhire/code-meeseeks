import type { Logger } from 'pino';
import type {
  LocalPrStatus,
  PlatformAdapter,
  PollResult,
  Reviewer,
  ReviewerStatus,
  StoredPullRequest,
} from '@pr-pilot/shared';
import type { StateStore } from '@pr-pilot/state-store';
import { PR_INDEX_KEY, type PullRequestsIndexFile } from './types.js';

/**
 * 兼容旧版 pull-requests.json：早期 reviewer 形状是
 * `{ name, displayName, approved: boolean }`，新版改为 `{ name, displayName, status }`。
 * 读到旧字段时翻译过来，避免渲染层把已 approved 误判成 pending。下一轮 poll 写回时
 * 自动落到新形状，迁移是一次性的。
 */
function normalizeReviewer(r: Reviewer & { approved?: boolean }): Reviewer {
  if (r.status) return r;
  return {
    name: r.name,
    displayName: r.displayName,
    status: r.approved ? 'approved' : 'unapproved',
  };
}

/**
 * 旧版 localStatus 取值是 'pending' | 'reviewed' | 'skipped' | 'ignored'。
 * 新模型仅保留 pending / approved / needs_work，把 BBS reviewer status 当作真实来源。
 *
 * - reviewed → approved (旧"已评"语义最接近 approve)
 * - skipped / ignored → pending (这两个仅是隐藏列表的本地操作，没有远端语义)
 * - 其余未知值 → pending (兜底)
 */
function normalizeLocalStatus(s: unknown): LocalPrStatus {
  if (s === 'approved' || s === 'needs_work' || s === 'pending') return s;
  if (s === 'reviewed') return 'approved';
  return 'pending';
}

function normalizeStoredPr(pr: StoredPullRequest): StoredPullRequest {
  return {
    ...pr,
    reviewers: pr.reviewers.map(normalizeReviewer),
    localStatus: normalizeLocalStatus(pr.localStatus),
  };
}

/** BBS reviewer.status → 本地 LocalPrStatus 单向映射（poll 时把远端权威态拉下来）。 */
function statusFromReviewer(s: ReviewerStatus | undefined): LocalPrStatus {
  if (s === 'approved') return 'approved';
  if (s === 'needsWork') return 'needs_work';
  return 'pending';
}

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
  /** 每次 tick 完成（含 errors=N 但未抛出）后回调；用于 main → renderer 推送 */
  onTick?: (info: { at: string; result: PollResult }) => void;
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
  private _lastPollAt: string | null = null;

  constructor(private readonly opts: PollerOptions) {}

  /** 最近一次成功 pollOnce 完成的时间（ISO）；从未跑过返回 null */
  getLastPollAt(): string | null {
    return this._lastPollAt;
  }

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
    const existing = (
      (await this.opts.stateStore.read<PullRequestsIndexFile>(PR_INDEX_KEY))?.pull_requests ?? []
    ).map(normalizeStoredPr);
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
          if (prev && prev.updatedAt !== pr.updatedAt) changed++;
          if (!prev) added++;

          // localStatus 直接镜像 BBS 上当前用户的 reviewer.status。
          // UI 上点 approve / needs work 时会先 PUT 到 BBS，再下一轮 poll 时此处取回。
          const mine = me ? pr.reviewers.find((r) => r.name === me.name) : undefined;
          const localStatus = statusFromReviewer(mine?.status);

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
    this._lastPollAt = now;
    this.opts.logger.info(result, 'poll complete');
    this.opts.onTick?.({ at: now, result });
    return result;
  }
}

/**
 * 在本地状态文件里覆写某 PR 的 localStatus。
 *
 * 调用方（IPC handler）通常先 PUT 到 BBS 成功后再调本函数，让本地立即反映新状态；
 * 下一轮 poll 会从 BBS 拿到同样的值，不会产生抖动。BBS 写入失败时不应该调用本函数。
 */
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

/** 读取 PR 列表（不存在时返回空数组）。读时做一次 reviewer 形状迁移。 */
export async function listStoredPullRequests(stateStore: StateStore): Promise<StoredPullRequest[]> {
  const file = await stateStore.read<PullRequestsIndexFile>(PR_INDEX_KEY);
  return (file?.pull_requests ?? []).map(normalizeStoredPr);
}
