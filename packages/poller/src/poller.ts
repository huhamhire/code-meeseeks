import type { Logger } from 'pino';
import type {
  LocalPrStatus,
  PlatformKind,
  PollResult,
  PrDiscoveryFilter,
  PullRequest,
  ReviewerStatus,
} from '@meebox/shared';
import type { PlatformAdapter } from '@meebox/platform-core';
import { relocateTree, type StateStore } from '@meebox/state-store';
import { prHashId } from './pr-hash-id.js';
import { latestCommentToMeAt } from './unread.js';
import {
  PURGE_GRACE_MS,
  prDirKey,
  readPrIndex,
  readPrMeta,
  writePrIndex,
  writePrMeta,
  type PrIndexEntry,
  type PrIndexFile,
} from './pr-state.js';

/** Bitbucket reviewer.status → 本地 LocalPrStatus 单向映射（poll 时把远端权威态拉下来）。 */
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
  /** 活跃 PR 存储（`state/` 根）：索引 + 在场 PR 的 meta / 评论 / runs 等。 */
  stateStore: StateStore;
  /**
   * 归档 PR 冷存储（`archived/` 根，与 state/ 平级）。PR 退场（软删）时其 `prs/<hash>/` 整树从
   * stateStore 搬入此处、复活时搬回；硬清按同一 grace 策略从此处删除。索引仍只在 stateStore 维护。
   */
  archiveStore: StateStore;
  intervalSeconds: number;
  logger: Logger;
  /** 用于测试注入；默认 Date.now() */
  now?: () => Date;
  /** 每次 tick 完成（含 errors=N 但未抛出）后回调；用于 main → renderer 推送 */
  onTick?: (info: { at: string; result: PollResult }) => void;
  /**
   * 本轮 poll 发现"有新增 / 内容变更的 PR"的 repo 集合（去重）。main 拿到后可以
   * 顺手 `repoMirror.syncMirror(...)` 把本地镜像跟上，让用户随后点开 PR 时省一
   * 趟 fetch。失败 / 无 PR 变化的连接不会出现在集合中。
   *
   * 仅触发条件：该 repo 至少有一个 PR 在本轮被识别为 added 或 changed
   * (updatedAt 跳变)。removed 不算 (PR 关单一般不影响 commit 范围)。
   */
  onPrsChanged?: (repos: ReadonlyArray<ChangedRepo>) => void;
}

/**
 * Poll 时通知 main 哪些 repo 有 PR 变更。字段是 PrIdentity 的 repo 投影 (去掉
 * remoteId / url)，足够 main 拼 RepoIdentity 并触发 syncMirror。
 */
export interface ChangedRepo {
  platform: PlatformKind;
  connectionId: string;
  group: string;
  repo: string;
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
  /** tick 在 inFlight 期间又被请求 → 标记，当前轮结束后紧接着补跑一轮（不丢请求）。 */
  private rerunRequested = false;
  private _lastPollAt: string | null = null;
  /** 可热替换的连接集合（设置页改连接 / 切换启用时换）。初值取自构造 opts */
  private connections: ReadonlyArray<PollerConnection>;
  /** 可热替换的轮询间隔（秒）。初值取自构造 opts */
  private intervalSeconds: number;

  constructor(private readonly opts: PollerOptions) {
    this.connections = opts.connections;
    this.intervalSeconds = opts.intervalSeconds;
  }

  /**
   * 热替换轮询的连接集合（设置页改连接 / 切换启用后调用）。下一轮 poll 生效；
   * 不在此处主动 tick，调用方决定是否立即触发一次。
   */
  setConnections(connections: ReadonlyArray<PollerConnection>): void {
    this.connections = connections;
  }

  /**
   * 归档所有「不属于 activeIds」连接的 PR，使其进入 purge 路径。
   *
   * 背景：单活动连接模型下 poller 只喂活动连接，软删只处理本轮 poll 到的连接
   * （seenByConnection）。切换/禁用连接后，旧连接的 PR 永远不会被 poll 到 → 永不
   * archived → 永不 purge，磁盘上累积陈旧状态。本方法在**用户显式切换/禁用连接**时由
   * main 调用，把这些 PR 标 archivedAt；后续任意一轮 poll 的 purge 段（grace 期满）会清掉。
   *
   * 仅由显式动作触发（非网络故障），故不违反「一次网络抖动不误删整库」的不变式。
   */
  async archiveConnectionsExcept(activeIds: readonly string[]): Promise<void> {
    const active = new Set(activeIds);
    const indexFile = await readPrIndex(this.opts.stateStore);
    if (!indexFile) return;
    const now = (this.opts.now?.() ?? new Date()).toISOString();
    const prs = { ...indexFile.prs };
    let dirty = false;
    for (const [localId, entry] of Object.entries(prs)) {
      if (!active.has(entry.identity.connectionId) && !entry.archivedAt) {
        // 整树搬入归档冷存储后再标 archivedAt（搬迁先于索引落盘，崩溃可幂等重来）。
        await relocateTree(this.opts.stateStore, this.opts.archiveStore, prDirKey(localId));
        prs[localId] = { ...entry, archivedAt: now };
        dirty = true;
      }
    }
    if (dirty) {
      await writePrIndex(this.opts.stateStore, { schema_version: 1, prs });
    }
  }

  /**
   * 热替换轮询间隔（秒）。运行中则按新周期重建定时器（不立即 tick）；下一次触发
   * 起用新间隔。设置页改轮询间隔后调用，无需重启。
   */
  setIntervalSeconds(seconds: number): void {
    this.intervalSeconds = seconds;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = setInterval(() => void this.tick(), this.intervalSeconds * 1000);
    }
  }

  /** 最近一次成功 pollOnce 完成的时间（ISO）；从未跑过返回 null */
  getLastPollAt(): string | null {
    return this._lastPollAt;
  }

  /**
   * 启动常驻轮询。`immediate=true`（默认）立刻先跑一轮；`immediate=false` 只装定时器、
   * 不跑首轮——用于「活动连接无缓存身份」场景：避免用 me=null 跑出半成品首轮，改由调用方
   * 在 ping 确认身份后再触发首次 tick（见 index.ts pingConnections）。
   */
  start(immediate = true): void {
    if (this.interval) return;
    if (immediate) void this.tick();
    this.interval = setInterval(() => void this.tick(), this.intervalSeconds * 1000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  /**
   * 立刻发起一次 poll。若上一次还在跑，则不并发，而是登记「补跑」：当前轮结束后紧接着再跑
   * 一轮。这样在「ping 异步补到 currentUser 后请求重新分类」等场景下，请求不会因恰好撞上
   * 进行中的 poll 而被丢弃。
   */
  async tick(): Promise<PollResult> {
    if (this.inFlight) {
      this.rerunRequested = true;
      return EMPTY;
    }
    this.inFlight = true;
    try {
      let result = await this.pollOnce();
      while (this.rerunRequested) {
        this.rerunRequested = false;
        result = await this.pollOnce();
      }
      return result;
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
    const indexByLocalId = new Map<string, PrIndexEntry>(Object.entries(indexFile?.prs ?? {}));

    let fetched = 0;
    let changed = 0;
    let added = 0;
    let removed = 0;
    let errors = 0;
    // dirty 跟踪本轮是否有任何状态变化 (meta 写入 / 软删 / 硬清)。全无变化时
    // 跳过索引文件 rewrite，磁盘 mtime 不动 (invariant #2)
    let dirty = false;
    // 本轮发现"有新增 / 内容变更 PR"的 repo 集合 (去重)；用于 onPrsChanged
    // 通知 main 触发 syncMirror。key = `${connectionId}|${group}|${repo}`
    const changedReposByKey = new Map<string, ChangedRepo>();

    // 每个**成功** poll 的连接看到的 localId 集合。失败的连接不进入此 map (invariant #1)
    const seenByConnection = new Map<string, Set<string>>();

    for (const { connectionId, adapter } of this.connections) {
      const me = adapter.connection.getCurrentUser();
      try {
        // 发现分类：平台提供多类（GitHub 四类）→ 逐类轮询并 union 打标，让 renderer 切标签
        // 走本地缓存而非每次拉远端；无分类的平台（Bitbucket）单轮询、标记为空数组。
        const filters = adapter.connection.capabilities().discoveryFilters ?? [];
        const merged = new Map<string, { pr: PullRequest; matched: PrDiscoveryFilter[] }>();
        const collect = async (filter?: PrDiscoveryFilter): Promise<void> => {
          const remote = await adapter.prs.listPendingPullRequests(filter ? { filter } : undefined);
          for (const pr of remote) {
            const k = `${pr.repo.projectKey}|${pr.repo.repoSlug}|${pr.remoteId}`;
            const e = merged.get(k);
            if (e) {
              if (filter && !e.matched.includes(filter)) e.matched.push(filter);
            } else {
              merged.set(k, { pr, matched: filter ? [filter] : [] });
            }
          }
        };
        if (filters.length === 0) await collect();
        else for (const f of filters) await collect(f);

        fetched += merged.size;
        const seen = new Set<string>();
        seenByConnection.set(connectionId, seen);

        for (const { pr, matched } of merged.values()) {
          // hash localId：platform + 连接 + group + repo + remoteId 一锅哈希。
          // 同一 connection 下不同 repo 同 PR id 也能区分开 (Bitbucket 的 PR id 是 per-repo
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
          const isAdded = !prev;
          const isChanged = Boolean(prev && prev.updatedAt !== pr.updatedAt);
          if (isChanged) changed++;
          if (isAdded) added++;
          if (isAdded || isChanged) {
            const repoKey = `${connectionId}|${identity.group}|${identity.repo}`;
            if (!changedReposByKey.has(repoKey)) {
              changedReposByKey.set(repoKey, {
                platform: identity.platform,
                connectionId,
                group: identity.group,
                repo: identity.repo,
              });
            }
          }

          // localStatus 直接镜像远端当前用户的 reviewer.status（远端为权威态）。
          // UI 上点 approve / needs work 时会先 PUT 到远端，再下一轮 poll 时此处取回。
          // currentUser 未知时（ping 未完成/失败）无法可靠判定本人评审态：此时**保留已记录的
          // 状态**而非覆盖成 pending，避免「已评审」被误降级（首轮 poll 已由 main 确保 me 就绪，
          // 此分支仅作 ping 异常时的兜底）。
          let localStatus: LocalPrStatus;
          if (me) {
            const mine = pr.reviewers.find((r) => r.name === me.name);
            localStatus = statusFromReviewer(mine?.status);
          } else {
            const prevMeta = prev ? await readPrMeta(this.opts.stateStore, localId) : null;
            localStatus = prevMeta?.pr.localStatus ?? 'pending';
          }

          // 复活：上一轮处于归档态（数据已搬入 archived/）→ 先把整树搬回活跃存储，再写 meta，
          // 让 runs / 评论 / 已读水位等历史与新 meta 同处活跃目录（搬回先于 writePrMeta，避免 split）。
          if (prev?.archivedAt) {
            await relocateTree(this.opts.archiveStore, this.opts.stateStore, prDirKey(localId));
          }

          // 完整 PR 元数据落到 per-PR meta.json。platform 字段让 meta 自描述
          await writePrMeta(this.opts.stateStore, localId, {
            ...pr,
            localId,
            platform: adapter.kind,
            connectionId,
            localStatus,
            discoveryFilters: matched,
            discoveredAt: prev?.discoveredAt ?? now,
            lastSeenAt: now,
          });
          dirty = true;

          // 未读 mention 游标（见 pr-state computeUnread）：仅当 PR 内容变更（updatedAt 跳变 → 可能有新评论）且
          // me 已知时拉评论扫「@我 / 回复我」，与历史游标取较大值。新到达 / 新 commit 未读无需在此处理（读取时分别按
          // 发现时间 vs 未读纪元、head sha 比对派生）。read-state 仅由 markRead（用户打开 PR）写，poll 一概不碰。
          let lastMentionAt = prev?.lastMentionAt;
          if (isChanged && me) {
            try {
              const comments = await adapter.comments.listPullRequestComments(
                { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
                pr.remoteId,
              );
              const latest = latestCommentToMeAt(comments, me);
              if (latest && (!lastMentionAt || Date.parse(latest) > Date.parse(lastMentionAt))) {
                lastMentionAt = latest;
              }
            } catch (err) {
              this.opts.logger.warn(
                { err, connectionId, localId },
                'unread scan: failed to list comments',
              );
            }
          }

          // 索引条目：仅 lookup/退场判定需要的字段；archivedAt 反向恢复 (远端回来了)
          indexByLocalId.set(localId, {
            identity,
            updatedAt: pr.updatedAt,
            discoveredAt: prev?.discoveredAt ?? now,
            lastSeenAt: now,
            archivedAt: null,
            lastMentionAt,
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
          // 整树搬入归档冷存储后再标 archivedAt（搬迁先于索引落盘，崩溃可幂等重来）。
          await relocateTree(this.opts.stateStore, this.opts.archiveStore, prDirKey(localId));
          indexByLocalId.set(localId, { ...entry, archivedAt: now });
          removed++;
          dirty = true;
        }
      }
    }

    // 硬清：archived 超过 grace 期 (默认 1 周) → rm -r 整个 PR 目录 + 索引删除
    let purged = 0;
    let reconciled = 0;
    for (const [localId, entry] of [...indexByLocalId.entries()]) {
      if (!entry.archivedAt) continue;
      if (nowMs - Date.parse(entry.archivedAt) > PURGE_GRACE_MS) {
        // 硬清：grace 期满 → 两端整目录清（archiveStore 主存 + stateStore 兜旧布局 / split-brain 残留）。
        await this.opts.archiveStore.deleteDir(prDirKey(localId));
        await this.opts.stateStore.deleteDir(prDirKey(localId));
        indexByLocalId.delete(localId);
        purged++;
        dirty = true;
      } else {
        // 对账（最终一致）：凡 archived 条目其数据都应在 archiveStore。把仍滞留活跃存储的整树搬入归档——
        // 涵盖旧布局存量、异常 split-brain 残留、中断的搬迁。已就位者源缺失即 no-op、近零成本。
        // 仅搬数据、不改索引（archivedAt 不变），故不置 dirty——保持「全失败 poll 零索引写」不变式。
        const moved = await relocateTree(
          this.opts.stateStore,
          this.opts.archiveStore,
          prDirKey(localId),
        );
        if (moved > 0) reconciled++;
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
    this.opts.logger.info({ ...result, purged, reconciled, dirty }, 'poll complete');
    // 通知调用方有哪些 repo 需要 sync mirror。空集合不调，避免无谓 noop
    if (changedReposByKey.size > 0) {
      this.opts.onPrsChanged?.(Array.from(changedReposByKey.values()));
    }
    this.opts.onTick?.({ at: now, result });
    return result;
  }
}

// listStoredPullRequests / setLocalStatus 移到 pr-state.ts，跟新 schema 一起维护
