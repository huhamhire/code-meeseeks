import type { Logger } from 'pino';
import type {
  LocalPrStatus,
  PlatformKind,
  PollNotificationEvent,
  PollResult,
  PrDiscoveryFilter,
  PullRequest,
  ReviewerStatus,
} from '@meebox/shared';
import type { PlatformAdapter } from '@meebox/platform-core';
import { relocateTree, type StateStore } from '@meebox/state-store';
import { prHashId } from './pr-hash-id.js';
import { collectCommentsFromOthers, collectMentionsToMe } from './unread.js';
import {
  MENTION_ATS_CAP,
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
  /**
   * 本轮 poll 新发生的「值得提醒」事件（新 PR / 被 @ / 被回复）。main 据通知配置弹系统通知。仅在**已有基线**
   * （索引此前非空）时产出，避免首启 / 批量涌入时通知风暴；空数组不回调。详见 PollNotificationEvent。
   */
  onNotify?: (events: ReadonlyArray<PollNotificationEvent>) => void;
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
    // 已有基线 = 本轮之前索引已非空。首轮 / 清库后的首 poll 不产出通知事件（仅建基线），避免涌入风暴。
    const hadBaseline = indexByLocalId.size > 0;
    // 本轮新发生的通知事件（新 PR / 被 @ / 被回复）；poll 末投影给 main 弹系统通知。
    const notifyEvents: PollNotificationEvent[] = [];

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
        const caps = adapter.connection.capabilities();
        // 评论计数是否「含回复」：true（GitHub/GitLab）→ 计数/updatedAt 变化才扫；false（Bitbucket，
        // 计数仅顶层、updatedDate 也不随评论跳变）→ 对待处理 PR 每轮兜底扫，否则漏「回复」类通知。
        const commentCountIncludesReplies = caps.commentCountIncludesReplies;
        // 发现分类：平台提供多类（GitHub 四类）→ 逐类轮询并 union 打标，让 renderer 切标签
        // 走本地缓存而非每次拉远端；无分类的平台（Bitbucket）单轮询、标记为空数组。
        const filters = caps.discoveryFilters ?? [];
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

          // 通知仅针对「待处理」(localStatus==='pending') 的 PR：已 approve / 标记 needs_work 的不再打扰。
          // 新 PR（仅已有基线时，避免首启涌入风暴）。mention/reply 事件在下方评论扫描处投影（同样受 pending 门控）。
          const notifiable = hadBaseline && localStatus === 'pending';
          if (isAdded && notifiable) {
            notifyEvents.push({
              kind: 'new_pr',
              localId,
              connectionId,
              remoteId: pr.remoteId,
              title: pr.title,
              repo: pr.repo,
              actor: pr.author,
            });
          }

          // 「我创建的」PR（作者为本人）通知：被标记需修改 / 出现冲突。仅在已有基线 + 已知 PR（prev）时探测；
          // 各自的上一轮快照字段缺失（升级前旧索引）时按「基线」处理——只在下方索引写入处播种、不补发历史事件。
          const authoredByMe = !!me && pr.author.name === me.name;
          const needsWorkReviewers = pr.reviewers
            .filter((r) => r.status === 'needsWork')
            .map((r) => r.name);
          if (authoredByMe && hadBaseline && prev) {
            // 新出现的「需修改」评审人（本轮在 needsWork、上一轮不在）→ authored_needs_work。
            const prevNW = prev.needsWorkReviewers;
            if (prevNW !== undefined) {
              const fresh = needsWorkReviewers.filter((n) => !prevNW.includes(n));
              if (fresh.length > 0) {
                const reviewer = pr.reviewers.find((r) => r.name === fresh[0]) ?? pr.author;
                notifyEvents.push({
                  kind: 'authored_needs_work',
                  localId,
                  connectionId,
                  remoteId: pr.remoteId,
                  title: pr.title,
                  repo: pr.repo,
                  actor: reviewer,
                });
              }
            }
            // 合并冲突 false→true → authored_conflict（无具体发起人，actor 取 PR 作者本人）。
            if (prev.hasConflict === false && pr.hasConflict === true) {
              notifyEvents.push({
                kind: 'authored_conflict',
                localId,
                connectionId,
                remoteId: pr.remoteId,
                title: pr.title,
                repo: pr.repo,
                actor: pr.author,
              });
            }
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

          // 未读 mention（见 pr-state computeUnread / computeUnreadMentionCount）：拉评论扫「@我 / 回复我」。
          // 游标 lastMentionAt 取较大值（驱动未读点）；mentionAts 与历史并集去重、按时间降序留最近 MENTION_ATS_CAP
          // 条（驱动未读点旁的计数）。新到达 / 新 commit 未读无需在此处理（读取时分别按发现时间 vs 未读纪元、head sha
          // 比对派生）。read-state 仅由 markRead 写，poll 不碰。
          //
          // 评论跟踪**仅针对「待处理」(notifiable=pending) PR**（含「待我评审」与「我创建的」），且需 me 已知。
          // 是否拉评论：
          //   - 含回复的平台（commentCountIncludesReplies）：仅当 updatedAt 跳变或 commentCount 变化（可能有新评论）
          //     才扫——省请求。
          //   - 不含回复的平台（Bitbucket：updatedDate 不随评论跳、commentCount 仅顶层不含回复）：无任何免费的
          //     「含回复」信号 → 对待处理 PR 每轮兜底扫一次，否则漏「回复」类通知。
          const commentCountChanged =
            prev?.commentCount !== undefined &&
            pr.commentCount !== undefined &&
            prev.commentCount !== pr.commentCount;
          const shouldScanComments = commentCountIncludesReplies
            ? isChanged || commentCountChanged
            : true;
          let lastMentionAt = prev?.lastMentionAt;
          let mentionAts = prev?.mentionAts;
          let lastCommentAt = prev?.lastCommentAt;
          if (notifiable && me && shouldScanComments) {
            try {
              const comments = await adapter.comments.listPullRequestComments(
                { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
                pr.remoteId,
              );
              const hits = collectMentionsToMe(comments, me);
              if (hits.length) {
                const scanned = hits.map((h) => h.at);
                const merged = [...new Set([...(prev?.mentionAts ?? []), ...scanned])];
                merged.sort((a, b) => Date.parse(b) - Date.parse(a));
                mentionAts = merged.slice(0, MENTION_ATS_CAP);
                const prevCursor = prev?.lastMentionAt;
                const latest = mentionAts[0];
                if (!lastMentionAt || Date.parse(latest) > Date.parse(lastMentionAt)) {
                  lastMentionAt = latest;
                }
                // 通知：仅对**已知 PR**（prev 存在）投影（外层已保证 notifiable=已有基线 + 待处理）；取晚于历史游标
                // 的命中按类型聚合条数。新 PR 此前历史评论不计（prev 不存在则跳过），避免新发现 PR 触发其旧评论的提醒风暴。
                if (prev) {
                  const sinceMs = prevCursor ? Date.parse(prevCursor) : 0;
                  const fresh = hits.filter((h) => Date.parse(h.at) > sinceMs);
                  // 按类型聚合本轮新增条数；发起人与点击定位取该类最新一条命中（通知头像 + 跳转目标）。
                  const project = (kind: 'reply' | 'mention'): void => {
                    const subset = fresh.filter((h) => h.kind === kind);
                    if (subset.length === 0) return;
                    const latestHit = subset.reduce((a, b) =>
                      Date.parse(b.at) > Date.parse(a.at) ? b : a,
                    );
                    notifyEvents.push({
                      kind,
                      localId,
                      connectionId,
                      remoteId: pr.remoteId,
                      title: pr.title,
                      repo: pr.repo,
                      actor: latestHit.author,
                      count: subset.length,
                      comment: { remoteId: latestHit.commentRemoteId, anchor: latestHit.anchor },
                    });
                  };
                  project('reply');
                  project('mention');
                }
              }
              // 「我创建的」PR：他人新评论（不限是否 @我 / 回复我，自己的评论不计）→ authored_comment。
              // 独立游标 lastCommentAt：晚于它的他人评论计为新；游标缺失（升级前）时仅播种、不补发历史评论。
              if (authoredByMe) {
                const others = collectCommentsFromOthers(comments, me);
                if (others.length) {
                  const newest = others.reduce((a, b) =>
                    Date.parse(b.at) > Date.parse(a.at) ? b : a,
                  );
                  const prevCursor = prev?.lastCommentAt;
                  if (prevCursor !== undefined) {
                    const sinceMs = Date.parse(prevCursor);
                    const fresh = others.filter((o) => Date.parse(o.at) > sinceMs);
                    if (fresh.length > 0) {
                      const latest = fresh.reduce((a, b) =>
                        Date.parse(b.at) > Date.parse(a.at) ? b : a,
                      );
                      notifyEvents.push({
                        kind: 'authored_comment',
                        localId,
                        connectionId,
                        remoteId: pr.remoteId,
                        title: pr.title,
                        repo: pr.repo,
                        actor: latest.author,
                        count: fresh.length,
                        comment: { remoteId: latest.commentRemoteId, anchor: latest.anchor },
                      });
                    }
                  }
                  if (!lastCommentAt || Date.parse(newest.at) > Date.parse(lastCommentAt)) {
                    lastCommentAt = newest.at;
                  }
                }
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
            commentCount: pr.commentCount,
            discoveredAt: prev?.discoveredAt ?? now,
            lastSeenAt: now,
            archivedAt: null,
            lastMentionAt,
            mentionAts,
            hasConflict: pr.hasConflict,
            needsWorkReviewers,
            lastCommentAt,
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
    // 本轮通知事件投影给 main（弹系统通知）。空数组不调。
    if (notifyEvents.length > 0) {
      this.opts.onNotify?.(notifyEvents);
    }
    this.opts.onTick?.({ at: now, result });
    return result;
  }
}

// listStoredPullRequests / setLocalStatus 移到 pr-state.ts，跟新 schema 一起维护
