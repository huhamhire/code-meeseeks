import type { Logger } from 'pino';
import type {
  LocalPrStatus,
  PlatformAdapter,
  PollResult,
  ReviewerStatus,
} from '@pr-pilot/shared';
import type { StateStore } from '@pr-pilot/state-store';
import { prHashId } from './pr-hash-id.js';
import {
  PURGE_GRACE_MS,
  prDirKey,
  readPrIndex,
  writePrIndex,
  writePrMeta,
  type PrIndexEntry,
  type PrIndexFile,
} from './pr-state.js';

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

  /**
   * 单轮 poll 的安全 invariants（用户硬要求 / 设计文档化）：
   *
   * 1. **拉取失败 → 不动本地** ：单个连接 listPendingPullRequests 抛错时，**只算**
   *    `errors++`，**不**：
   *      - 写其名下任何 PR 的 meta
   *      - 把名下既有 PR 软删 (archive)
   *      - 从索引中剔除任何条目
   *    实现靠 seenByConnection 只装成功连接的 hash 集合；soft archive 循环只迭代
   *    seenByConnection 里的连接。
   *
   * 2. **所有连接全失败 → 索引文件 0 写** ：dirty flag 控制；磁盘 mtime 不变，
   *    避免上层 file watcher 误触发 / 备份工具误以为有改动。
   *
   * 3. **硬清 (grace 期满 archive 条目)** 跟当轮 poll 成败无关：archivedAt 是过去
   *    某次成功 poll 决定的事实，时间到了该清就清。
   */
  private async pollOnce(): Promise<PollResult> {
    const now = (this.opts.now?.() ?? new Date()).toISOString();
    const nowMs = Date.parse(now);
    const indexFile = await readPrIndex(this.opts.stateStore);
    // 索引拷一份到 mutable Map 方便增删；条目缺失时退回到空 Map (首次 poll)
    const indexByLocalId = new Map<string, PrIndexEntry>(
      Object.entries(indexFile?.prs ?? {}),
    );

    let fetched = 0;
    let changed = 0;
    let added = 0;
    let removed = 0;
    let errors = 0;
    // dirty 跟踪本轮是否有任何状态变化 (meta 写入 / 软删 / 硬清)。全无变化时
    // 跳过索引文件 rewrite，磁盘 mtime 不动 (invariant #2)
    let dirty = false;

    // 每个**成功** poll 的连接看到的 localId 集合。失败的连接不进入此 map (invariant #1)
    const seenByConnection = new Map<string, Set<string>>();

    for (const { connectionId, adapter } of this.opts.connections) {
      const me = adapter.getCurrentUser();
      try {
        const remote = await adapter.listPendingPullRequests();
        fetched += remote.length;
        const seen = new Set<string>();
        seenByConnection.set(connectionId, seen);

        for (const pr of remote) {
          // hash localId：platform + 连接 + group + repo + remoteId 一锅哈希。
          // 同一 connection 下不同 repo 同 PR id 也能区分开 (BBS 的 PR id 是 per-repo
          // 递增的)；platform 字段让多平台扩展时 schema 不必改
          const identity = {
            platform: adapter.kind,
            connectionId,
            group: pr.repo.projectKey,
            repo: pr.repo.repoSlug,
            remoteId: pr.remoteId,
            url: pr.url, // 仅快照，不进 hash
          };
          const localId = prHashId(identity);
          seen.add(localId);
          const prev = indexByLocalId.get(localId);
          if (prev && prev.updatedAt !== pr.updatedAt) changed++;
          if (!prev) added++;

          // localStatus 直接镜像 BBS 上当前用户的 reviewer.status。
          // UI 上点 approve / needs work 时会先 PUT 到 BBS，再下一轮 poll 时此处取回。
          const mine = me ? pr.reviewers.find((r) => r.name === me.name) : undefined;
          const localStatus = statusFromReviewer(mine?.status);

          // 完整 PR 元数据落到 per-PR meta.json。platform 字段让 meta 自描述
          await writePrMeta(this.opts.stateStore, localId, {
            ...pr,
            localId,
            platform: adapter.kind,
            connectionId,
            localStatus,
            discoveredAt: prev?.discoveredAt ?? now,
            lastSeenAt: now,
          });
          dirty = true;

          // 索引条目：仅 lookup/退场判定需要的字段；archivedAt 反向恢复 (远端回来了)
          indexByLocalId.set(localId, {
            identity,
            updatedAt: pr.updatedAt,
            discoveredAt: prev?.discoveredAt ?? now,
            lastSeenAt: now,
            archivedAt: null,
          });
        }
      } catch (err) {
        errors++;
        this.opts.logger.error({ err, connectionId }, 'poll failed for connection');
      }
    }

    // 软删：每个成功 poll 的连接，"本地有 + 本轮没看到 + 还没 archived"的 PR
    // 标 archivedAt = now。失败的连接 (不在 seenByConnection) 不参与，避免一次
    // 网络故障误删整库
    for (const [connectionId, seen] of seenByConnection) {
      for (const [localId, entry] of indexByLocalId) {
        if (
          entry.identity.connectionId === connectionId &&
          !seen.has(localId) &&
          !entry.archivedAt
        ) {
          indexByLocalId.set(localId, { ...entry, archivedAt: now });
          removed++;
          dirty = true;
        }
      }
    }

    // 硬清：archived 超过 grace 期 (默认 1 周) → rm -r 整个 PR 目录 + 索引删除
    let purged = 0;
    for (const [localId, entry] of [...indexByLocalId.entries()]) {
      if (entry.archivedAt && nowMs - Date.parse(entry.archivedAt) > PURGE_GRACE_MS) {
        await this.opts.stateStore.deleteDir(prDirKey(localId));
        indexByLocalId.delete(localId);
        purged++;
        dirty = true;
      }
    }

    // 索引文件仅在本轮有实际变化时重写 (invariant #2)。全失败 / 全无变化的 poll
    // 不触磁盘 mtime
    if (dirty) {
      const next: PrIndexFile = {
        schema_version: 1,
        prs: Object.fromEntries(indexByLocalId),
      };
      await writePrIndex(this.opts.stateStore, next);
    }

    const result: PollResult = { fetched, changed, added, removed, errors };
    this._lastPollAt = now;
    this.opts.logger.info({ ...result, purged, dirty }, 'poll complete');
    this.opts.onTick?.({ at: now, result });
    return result;
  }
}

// listStoredPullRequests / setLocalStatus 移到 pr-state.ts，跟新 schema 一起维护
