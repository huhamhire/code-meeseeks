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

/** One-way mapping Bitbucket reviewer.status → local LocalPrStatus (poll pulls down the remote authoritative state). */
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
  /** Active PR store (`state/` root): index + meta / comments / runs etc. for present PRs. */
  stateStore: StateStore;
  /**
   * Archived PR cold storage (`archived/` root, a sibling of state/). When a PR departs (soft-delete) its
   * `prs/<hash>/` whole tree is moved from stateStore into here, and moved back on revival; hard purge deletes
   * from here under the same grace policy. The index is still maintained only in stateStore.
   */
  archiveStore: StateStore;
  intervalSeconds: number;
  logger: Logger;
  /** For test injection; defaults to Date.now() */
  now?: () => Date;
  /** Callback after each tick completes (including errors=N but not thrown); used for main → renderer push */
  onTick?: (info: { at: string; result: PollResult }) => void;
  /**
   * The set of repos where this poll round found "PRs newly added / content-changed" (deduped). After receiving it,
   * main can conveniently `repoMirror.syncMirror(...)` to catch the local mirror up, saving the user a fetch when they
   * later open the PR. Connections that failed / had no PR changes do not appear in the set.
   *
   * Trigger condition only: that repo has at least one PR recognized this round as added or changed (updatedAt jumped).
   * removed does not count (closing a PR generally does not affect the commit range).
   */
  onPrsChanged?: (repos: ReadonlyArray<ChangedRepo>) => void;
  /**
   * "Notification-worthy" events newly occurring this poll round (new PR / @mentioned / replied-to). main pops system
   * notifications per notification config. Produced only when **a baseline already exists** (the index was previously
   * non-empty), avoiding a notification storm on first launch / bulk influx; an empty array does not call back. See PollNotificationEvent.
   */
  onNotify?: (events: ReadonlyArray<PollNotificationEvent>) => void;
}

/**
 * Notify main during poll which repos have PR changes. The fields are the repo projection of PrIdentity (dropping
 * remoteId / url), enough for main to assemble RepoIdentity and trigger syncMirror.
 */
export interface ChangedRepo {
  platform: PlatformKind;
  connectionId: string;
  group: string;
  repo: string;
}

const EMPTY: PollResult = { fetched: 0, changed: 0, added: 0, removed: 0, errors: 0 };

/**
 * Periodic poll, merging PRs discovered across connections into `state/pull-requests.json`.
 *
 * Write strategy: preserve old PRs' localStatus and discoveredAt; rewrite the whole file each round
 * (single writer + atomic write — at small scale, simplicity beats diff merging).
 *
 * Concurrency: no re-entry within the same tick.
 */
export class Poller {
  private interval?: ReturnType<typeof setInterval>;
  private inFlight = false;
  /** tick requested again while inFlight → mark it, and immediately run one more round after the current one (no request dropped). */
  private rerunRequested = false;
  private _lastPollAt: string | null = null;
  /** Hot-swappable connection set (swapped when the settings page changes connections / toggles enablement). Initial value from constructor opts */
  private connections: ReadonlyArray<PollerConnection>;
  /** Hot-swappable poll interval (seconds). Initial value from constructor opts */
  private intervalSeconds: number;

  constructor(private readonly opts: PollerOptions) {
    this.connections = opts.connections;
    this.intervalSeconds = opts.intervalSeconds;
  }

  /**
   * Hot-swap the poll's connection set (called after the settings page changes connections / toggles enablement).
   * Takes effect next poll round; does not actively tick here — the caller decides whether to trigger one immediately.
   */
  setConnections(connections: ReadonlyArray<PollerConnection>): void {
    this.connections = connections;
  }

  /**
   * Archive all PRs of connections "not in activeIds", putting them on the purge path.
   *
   * Background: under the single-active-connection model the poller only feeds the active connection, and soft-delete
   * only handles connections polled this round (seenByConnection). After switching/disabling a connection, the old
   * connection's PRs are never polled → never archived → never purged, accumulating stale state on disk. This method is
   * called by main on **the user explicitly switching/disabling a connection**, marking these PRs' archivedAt; the purge
   * segment of any later poll round (grace expired) will clean them up.
   *
   * Triggered only by an explicit action (not a network failure), so it does not violate the "one network blip must not
   * wrongly delete the whole store" invariant.
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
        // Move the whole tree into archive cold storage, then mark archivedAt (migration precedes index persistence; a crash can idempotently retry).
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
   * Hot-swap the poll interval (seconds). While running, rebuild the timer on the new period (does not tick immediately);
   * the new interval takes effect from the next trigger. Called after the settings page changes the poll interval, no restart needed.
   */
  setIntervalSeconds(seconds: number): void {
    this.intervalSeconds = seconds;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = setInterval(() => void this.tick(), this.intervalSeconds * 1000);
    }
  }

  /** Time (ISO) the most recent successful pollOnce completed; returns null if never run */
  getLastPollAt(): string | null {
    return this._lastPollAt;
  }

  /**
   * Start the resident poll. `immediate=true` (default) runs one round right away; `immediate=false` only installs the
   * timer and skips the first round — for the "active connection has no cached identity" scenario: avoids running a
   * half-baked first round with me=null, letting the caller instead trigger the first tick after ping confirms the
   * identity (see index.ts pingConnections).
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
   * Trigger a poll immediately. If the previous one is still running, do not run concurrently but register a "rerun":
   * run one more round right after the current one ends. This way, in scenarios like "requesting re-classification after
   * ping asynchronously fills in currentUser", the request is not dropped just because it happened to collide with an
   * in-progress poll.
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
   * Safety invariants for a single poll round (hard user requirements / documented in design):
   *
   * 1. **Fetch failure → do not touch local**: when a single connection's listPendingPullRequests throws, **only**
   *    count `errors++`, and do **not**:
   *      - write meta for any of its PRs
   *      - soft-delete (archive) any of its existing PRs
   *      - remove any entry from the index
   *    Implemented via seenByConnection holding only successful connections' hash sets; the soft-archive loop iterates
   *    only connections in seenByConnection.
   *
   * 2. **All connections fail → 0 writes to the index file**: controlled by the dirty flag; disk mtime unchanged,
   *    avoiding false triggers of the upper file watcher / a backup tool mistakenly thinking there was a change.
   *
   * 3. **Hard purge (archive entries past grace)** is unrelated to this round's poll success/failure: archivedAt is a
   *    fact decided by some past successful poll; once the time is up, purge as due.
   */
  private async pollOnce(): Promise<PollResult> {
    const now = (this.opts.now?.() ?? new Date()).toISOString();
    const nowMs = Date.parse(now);
    const indexFile = await readPrIndex(this.opts.stateStore);
    // Copy the index into a mutable Map for easy add/remove; fall back to an empty Map when the entry is missing (first poll)
    const indexByLocalId = new Map<string, PrIndexEntry>(Object.entries(indexFile?.prs ?? {}));
    // Baseline exists = the index was already non-empty before this round. The first round / first poll after clearing the store produces no notification events (only builds the baseline), avoiding an influx storm.
    const hadBaseline = indexByLocalId.size > 0;
    // Notification events newly occurring this round (new PR / @mentioned / replied-to); projected to main at poll end to pop system notifications.
    const notifyEvents: PollNotificationEvent[] = [];

    let fetched = 0;
    let changed = 0;
    let added = 0;
    let removed = 0;
    let errors = 0;
    // dirty tracks whether this round had any state change (meta write / soft-delete / hard purge). When there is
    // no change at all, skip the index file rewrite and leave disk mtime untouched (invariant #2)
    let dirty = false;
    // The set of repos where this round found "PRs newly added / content-changed" (deduped); used by onPrsChanged
    // to notify main to trigger syncMirror. key = `${connectionId}|${group}|${repo}`
    const changedReposByKey = new Map<string, ChangedRepo>();

    // The localId set seen by each **successful** poll connection. Failed connections do not enter this map (invariant #1)
    const seenByConnection = new Map<string, Set<string>>();

    for (const { connectionId, adapter } of this.connections) {
      const me = adapter.connection.getCurrentUser();
      try {
        const caps = adapter.connection.capabilities();
        // Whether the comment count "includes replies": true (GitHub/GitLab) → scan only when the count/updatedAt changes;
        // false (Bitbucket — the count is top-level only and updatedDate does not jump with comments) → fallback-scan
        // pending PRs every round, otherwise "reply"-type notifications are missed.
        const commentCountIncludesReplies = caps.commentCountIncludesReplies;
        // Discovery categories: a platform providing multiple categories (GitHub's four) → poll each and union-tag, so the
        // renderer switches tabs via local cache instead of fetching remote each time; a platform without categories
        // (Bitbucket) is polled once and tagged with an empty array.
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
          // hash localId: platform + connection + group + repo + remoteId hashed all together.
          // Different repos under the same connection with the same PR id can also be distinguished (Bitbucket's PR id is
          // per-repo incrementing); the platform field means the schema need not change when expanding to multiple platforms
          const identity = {
            platform: adapter.kind,
            connectionId,
            group: pr.repo.projectKey,
            repo: pr.repo.repoSlug,
            remoteId: pr.remoteId,
            url: pr.url, // snapshot only, not part of the hash
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

          // localStatus directly mirrors the remote current user's reviewer.status (remote is authoritative).
          // Clicking approve / needs work in the UI first PUTs to remote, and this fetches it back on the next poll round.
          // When currentUser is unknown (ping incomplete/failed) one's own review state cannot be reliably determined:
          // in that case **keep the recorded status** rather than overwriting to pending, avoiding "reviewed" being wrongly
          // downgraded (the first poll round already has main ensure me is ready; this branch is only a fallback for ping errors).
          let localStatus: LocalPrStatus;
          if (me) {
            const mine = pr.reviewers.find((r) => r.name === me.name);
            localStatus = statusFromReviewer(mine?.status);
          } else {
            const prevMeta = prev ? await readPrMeta(this.opts.stateStore, localId) : null;
            localStatus = prevMeta?.pr.localStatus ?? 'pending';
          }

          // Notifications only target "pending" (localStatus==='pending') PRs: already-approved / marked-needs_work ones are no longer disturbed.
          // New PRs (only when a baseline exists, to avoid a first-launch influx storm). mention/reply events are projected at the comment scan below (also gated by pending).
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

          // "PRs I authored" (author is yourself) notifications: marked needs-work / a conflict appeared. Detected only when a baseline exists + PR is known (prev);
          // when the respective prior-round snapshot fields are missing (old index from before the upgrade), treated as "baseline" — only seeded at the index write below, not backfilled with historical events.
          const authoredByMe = !!me && pr.author.name === me.name;
          const needsWorkReviewers = pr.reviewers
            .filter((r) => r.status === 'needsWork')
            .map((r) => r.name);
          if (authoredByMe && hadBaseline && prev) {
            // Newly appearing "needs work" reviewers (in needsWork this round, not last round) → authored_needs_work.
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
            // Merge conflict false→true → authored_conflict (no specific initiator; actor is the PR author themselves).
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

          // Revival: last round was in archived state (data already moved into archived/) → first move the whole tree back
          // to active storage, then write meta, so runs / comments / read watermark history sits in the active directory
          // together with the new meta (moving back precedes writePrMeta, to avoid a split).
          if (prev?.archivedAt) {
            await relocateTree(this.opts.archiveStore, this.opts.stateStore, prDirKey(localId));
          }

          // Full PR metadata written to per-PR meta.json. The platform field makes meta self-describing
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

          // Unread mentions (see pr-state computeUnread / computeUnreadMentionCount): fetch comments and scan "@me / reply-to-me".
          // The cursor lastMentionAt takes the larger value (drives the unread dot); mentionAts dedupes against the historical
          // union and keeps the most recent MENTION_ATS_CAP entries in descending time order (drives the count next to the
          // unread dot). New-arrival / new-commit unread need not be handled here (on read they are derived by discovery time
          // vs unread epoch, and head sha comparison respectively). read-state is written only by markRead; poll does not touch it.
          //
          // Comment tracking is **only for "pending" (notifiable=pending) PRs** (including "awaiting my review" and "I authored"), and requires me to be known.
          // Whether to fetch comments:
          //   - Platforms including replies (commentCountIncludesReplies): scan only when updatedAt jumps or commentCount changes
          //     (there may be new comments) — saves requests.
          //   - Platforms not including replies (Bitbucket: updatedDate does not jump with comments, commentCount is top-level only,
          //     excluding replies): no free "includes replies" signal → fallback-scan pending PRs once per round, otherwise "reply"-type notifications are missed.
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
                // Notifications: projected only for **known PRs** (prev exists) (the outer layer already guarantees notifiable=baseline exists + pending);
                // take hits later than the historical cursor and aggregate counts by type. A new PR's prior historical comments do not count (skipped when prev does not exist), avoiding a newly discovered PR triggering a notification storm from its old comments.
                if (prev) {
                  const sinceMs = prevCursor ? Date.parse(prevCursor) : 0;
                  const fresh = hits.filter((h) => Date.parse(h.at) > sinceMs);
                  // Aggregate this round's new counts by type; the initiator and click target take that type's latest hit (notification avatar + jump target).
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
              // "PRs I authored": others' new comments (regardless of whether @me / reply-to-me; one's own comments do not count) → authored_comment.
              // Independent cursor lastCommentAt: others' comments later than it count as new; when the cursor is missing (before the upgrade) only seed, do not backfill historical comments.
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

          // Index entry: only the fields needed for lookup/departure decisions; archivedAt reverse recovery (remote came back)
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

    // Soft-delete: for each successful poll connection, PRs that are "present locally + not seen this round + not yet
    // archived" are marked archivedAt = now. Failed connections (not in seenByConnection) do not participate, avoiding
    // one network failure wrongly deleting the whole store
    for (const [connectionId, seen] of seenByConnection) {
      for (const [localId, entry] of indexByLocalId) {
        if (
          entry.identity.connectionId === connectionId &&
          !seen.has(localId) &&
          !entry.archivedAt
        ) {
          // Move the whole tree into archive cold storage, then mark archivedAt (migration precedes index persistence; a crash can idempotently retry).
          await relocateTree(this.opts.stateStore, this.opts.archiveStore, prDirKey(localId));
          indexByLocalId.set(localId, { ...entry, archivedAt: now });
          removed++;
          dirty = true;
        }
      }
    }

    // Hard purge: archived past the grace period (default 1 week) → rm -r the whole PR directory + remove from index
    let purged = 0;
    let reconciled = 0;
    for (const [localId, entry] of [...indexByLocalId.entries()]) {
      if (!entry.archivedAt) continue;
      if (nowMs - Date.parse(entry.archivedAt) > PURGE_GRACE_MS) {
        // Hard purge: grace expired → clear the whole directory on both ends (archiveStore primary + stateStore backstops old layout / split-brain residue).
        await this.opts.archiveStore.deleteDir(prDirKey(localId));
        await this.opts.stateStore.deleteDir(prDirKey(localId));
        indexByLocalId.delete(localId);
        purged++;
        dirty = true;
      } else {
        // Reconcile (eventual consistency): any archived entry's data should be in archiveStore. Move any whole tree still
        // lingering in active storage into the archive — covering old-layout backlog, abnormal split-brain residue, and
        // interrupted migrations. For those already in place, a missing source is a no-op at near-zero cost.
        // Only moves data, does not change the index (archivedAt unchanged), so does not set dirty — preserving the "all-failed poll writes zero index" invariant.
        const moved = await relocateTree(
          this.opts.stateStore,
          this.opts.archiveStore,
          prDirKey(localId),
        );
        if (moved > 0) reconciled++;
      }
    }

    // The index file is rewritten only when this round had actual changes (invariant #2). An all-failed / no-change poll
    // does not touch disk mtime
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
    // Notify the caller which repos need a mirror sync. An empty set is not called, avoiding a pointless noop
    if (changedReposByKey.size > 0) {
      this.opts.onPrsChanged?.(Array.from(changedReposByKey.values()));
    }
    // This round's notification events projected to main (pop system notifications). An empty array is not called.
    if (notifyEvents.length > 0) {
      this.opts.onNotify?.(notifyEvents);
    }
    this.opts.onTick?.({ at: now, result });
    return result;
  }
}

// listStoredPullRequests / setLocalStatus moved to pr-state.ts, maintained together with the new schema
