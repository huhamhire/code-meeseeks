import type { BootstrapResult } from '@meebox/config';
import {
  isDiffBaseCacheReusable,
  listStoredPullRequests,
  readDiffBaseCache,
  readPrIndex,
  readPrMeta,
  writeDiffBaseCache,
} from '@meebox/poller';
import type { RepoIdentity, RepoMirrorManager } from '@meebox/repo-mirror';
import {
  AppError,
  ERROR_CODES,
  pullRequestHeadRefspec,
  type StoredPullRequest,
} from '@meebox/shared';
import type { PlatformAdapter } from '@meebox/platform-core';
import type { JsonFileStateStore } from '@meebox/state-store';
import type { ConnectionRuntime } from '../adapters.js';
import { broadcast } from './broadcast.js';

/** PrService construction dependencies (injected by context). */
export interface PrServiceDeps {
  bootstrap: BootstrapResult;
  stateStore: JsonFileStateStore;
  /** Archived PR cold storage: fallback when the active store misses during PR lookup (opening an archived PR's details from the "closed" view). */
  archiveStore: JsonFileStateStore;
  /** Mutable connection runtime; reconfigure replaces the contents in place, and this service reads the latest adapters via the reference. */
  connectionRuntime: ConnectionRuntime;
  repoMirror: RepoMirrorManager;
}

/**
 * PR domain service: PR lookup / connection adapter resolution / repo mirror readiness / diff base resolution / comments cache invalidation.
 *
 * Collects the pr-lookup·mirror·comments-cache previously scattered in common/ into a single strong domain class, with dependencies injected via the constructor and
 * each method sharing `this.deps`, avoiding per-function pass-through. Controllers always call via `ctx.pr.<method>()`; callers
 * should invoke as instance methods (do not destructure methods, or the this binding is lost).
 */
export class PrService {
  /**
   * Indexes in-flight resolveDiffBaseSha by localId. When opening a PR, multiple handlers such as listChangedFiles / getFileContent /
   * getBlame / listCommits / getCommitCount concurrently resolve the same PR's diff-base: after dedup,
   * merge-base is computed once and diff-base.json is written once, avoiding concurrent writes to the same key (which triggers rename
   * EPERM on Windows, see JsonFileStateStore self-heal).
   */
  private readonly diffBaseInFlight = new Map<string, Promise<string>>();

  constructor(private readonly deps: PrServiceDeps) {}

  /**
   * Locate a PR by localId in the state store, throwing if not found (uniform error text). Query the active store first; on miss fall back to archived cold storage,
   * so an archived PR's diff / comments paths still resolve when opened from the "closed" view.
   */
  async findPrOrThrow(localId: string): Promise<StoredPullRequest> {
    const prs = await listStoredPullRequests(this.deps.stateStore);
    const pr = prs.find((p) => p.localId === localId);
    if (pr) return pr;
    const archived = await readPrMeta(this.deps.archiveStore, localId);
    if (archived) return archived.pr;
    throw new AppError(ERROR_CODES.PR_NOT_FOUND, { localId }, `PR not found in local state: ${localId}`);
  }

  /**
   * Resolve a PR's per-PR storage root: archived (index `archivedAt` non-empty) → archived cold storage, otherwise the active store.
   *
   * All per-PR subtree reads/writes (comments cache / drafts / close relations / review run / sessions / ledger / diff-base cache) should
   * land on the correct root after this resolution — otherwise a write for an archived PR lands in the active store and gets erroneously deleted along with archived data by the next poll reconciliation (`relocateTree` source overwrites
   * destination, clearing destination first) (see docs/arch/99-core/01-state-storage). The index is always maintained only in the active store, so decide by it.
   */
  async storeForPr(localId: string): Promise<JsonFileStateStore> {
    const index = await readPrIndex(this.deps.stateStore);
    return index?.prs[localId]?.archivedAt ? this.deps.archiveStore : this.deps.stateStore;
  }

  /** PR → RepoIdentity (host / projectKey / repoSlug); throws if the connection is missing. */
  repoIdentityFor(pr: StoredPullRequest): RepoIdentity {
    const conn = this.deps.bootstrap.config.connections.find((c) => c.id === pr.connectionId);
    if (!conn) throw new Error(`connection not found: ${pr.connectionId}`);
    return {
      host: new URL(conn.base_url).hostname,
      projectKey: pr.repo.projectKey,
      repoSlug: pr.repo.repoSlug,
    };
  }

  /** The adapter of the PR's connection; returns undefined when the connection has no adapter. */
  adapterFor(pr: StoredPullRequest): PlatformAdapter | undefined {
    return this.deps.connectionRuntime.adapters.find((a) => a.connectionId === pr.connectionId)
      ?.adapter;
  }

  /** Same as adapterFor, but throws when there is no adapter (the vast majority of handlers use it). */
  adapterForOrThrow(pr: StoredPullRequest): PlatformAdapter {
    const adapter = this.adapterFor(pr);
    if (!adapter) throw new Error(`no adapter for connection ${pr.connectionId}`);
    return adapter;
  }

  /**
   * Guarantees mirror readiness when opening a PR. Prefer the fast path: local bare already contains both head+base shas
   * → return mirrorPath directly, no remote call. Both shas present means the last sync already covered this PR's
   * commit range (PR sha is immutable), so the renderer can compute the diff locally.
   *
   * Missing sha (either one) → go through syncMirror falling back to git fetch.
   *
   * Background poll actively syncMirror after getting PR status updates, so on a normal PR open
   * the fast-path hit rate should be high.
   */
  async ensureMirrorReadyForPr(
    pr: StoredPullRequest,
  ): Promise<{ mirrorPath: string; freshClone: boolean }> {
    const id = this.repoIdentityFor(pr);
    const [hasHead, hasBase] = await Promise.all([
      this.deps.repoMirror.hasCommit(id, pr.sourceRef.sha),
      this.deps.repoMirror.hasCommit(id, pr.targetRef.sha),
    ]);
    if (hasHead && hasBase) {
      // Fast path: mirror already contains head + base, return directly without a remote call. Frequently hit, so no log.
      return { mirrorPath: this.deps.repoMirror.mirrorPath(id), freshClone: false };
    }
    const r = await this.deps.repoMirror.syncMirror(id);
    // Self-heal: after the source branch is deleted / force-pushed, head sha is not in refs/heads, and syncMirror (only fetches heads + Bitbucket wildcard PR refs)
    // still cannot backfill → precisely fetch the PR head ref by platform + PR number (GitHub refs/pull/<n>/head etc., unreachable by wildcard, must be precise).
    // Only after backfill does diff base...head not report "Invalid symmetric difference". Best-effort; if still missing, downstream diff throws a readable error.
    if (!(await this.deps.repoMirror.hasCommit(id, pr.sourceRef.sha))) {
      const refspec = pullRequestHeadRefspec(pr.platform, pr.remoteId);
      if (refspec) await this.deps.repoMirror.fetchRefspecs(id, [refspec]);
    }
    return { mirrorPath: r.mirrorPath, freshClone: r.freshClone };
  }

  /**
   * Resolve a PR diff's fixed base (merge-base) — see `@meebox/poller` diff-base-cache.
   *
   * A PR diff's semantic baseline is "where the source branch forked from the target branch" = `merge-base(targetRef.sha, sourceRef.sha)`,
   * not the target branch's current tip (which advances as other PRs merge in). Once computed, it is fixed in `prs/<localId>/diff-base.json`,
   * and thereafter listChangedFiles / file content / commitCount / blame / pr-agent worktree all use it as base:
   * - content (Monaco left column) anchored to merge-base → the editor is a true three-dot diff, and target drift no longer back-hangs other PRs' changes;
   * - line anchors (comment / finding) have a fixed reference, so target drift does not misalign them.
   *
   * Invalidate and recompute when:
   * - the fixed base is no longer an ancestor of the current head (source branch was rebased);
   * - the current target has become an ancestor of head, meaning the source branch merged the target branch in, and the old fork point would count the merge-brought
   *   target branch content into the PR diff too.
   * Uncomputable (missing object / no common ancestor) → fall back to targetRef.sha and **do not fix it**, retry next time.
   *
   * Precondition: mirror already contains head + targetRef.sha (the diff entry has already done ensureMirrorReadyForPr / syncMirror).
   */
  async resolveDiffBaseSha(pr: StoredPullRequest): Promise<string> {
    // Concurrency dedup: multiple concurrent resolutions of the same PR reuse the same in-flight Promise, computing once and writing diff-base.json once.
    const existing = this.diffBaseInFlight.get(pr.localId);
    if (existing) return existing;
    const promise = this.computeDiffBaseSha(pr).finally(() => {
      this.diffBaseInFlight.delete(pr.localId);
    });
    this.diffBaseInFlight.set(pr.localId, promise);
    return promise;
  }

  private async computeDiffBaseSha(pr: StoredPullRequest): Promise<string> {
    const id = this.repoIdentityFor(pr);
    const head = pr.sourceRef.sha;
    // For an archived PR (opened from the closed scope to view diff), its diff-base cache must land in archived storage, to avoid a write to the active store being erroneously deleted by reconciliation.
    const store = await this.storeForPr(pr.localId);
    const cached = await readDiffBaseCache(store, pr.localId);
    if (
      cached?.base_sha &&
      (await isDiffBaseCacheReusable({
        cachedBaseSha: cached.base_sha,
        targetSha: pr.targetRef.sha,
        headSha: head,
        isAncestor: (ancestor, descendant) =>
          this.deps.repoMirror.isAncestor(id, ancestor, descendant),
      }))
    ) {
      return cached.base_sha;
    }
    const mb = await this.deps.repoMirror.mergeBase(id, pr.targetRef.sha, head);
    if (!mb) return pr.targetRef.sha;
    await writeDiffBaseCache(store, pr.localId, {
      base_sha: mb,
      head_sha: head,
      computed_at: new Date().toISOString(),
    });
    return mb;
  }

  /**
   * Clear a PR's comments cache and broadcast `comments:changed`, so CommentsPanel / DiffView inline comments re-fetch and refresh.
   * Consolidates the path shared by comments reply/delete/edit and drafts:publishBatch (clear `prs/<localId>/comments`
   * cache → next listComments force-fetches remote → broadcast triggers a re-fetch). A cache miss is fine, swallow the exception.
   */
  async invalidateCommentsCache(localId: string): Promise<void> {
    try {
      const store = await this.storeForPr(localId);
      await store.delete(`prs/${localId}/comments`);
    } catch {
      /* cache miss is fine */
    }
    broadcast('comments:changed', { localId });
  }
}
