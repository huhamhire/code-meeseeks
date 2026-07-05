import {
  addFindingClosure,
  createDraft,
  deleteDraft,
  isCommentsCacheStale,
  listArchivedPullRequests,
  listDrafts,
  listFindingClosures,
  listStoredPullRequests,
  markPrRead,
  prHashId,
  readCommentsCache,
  readPrIndex,
  readPrMeta,
  removeFindingClosure,
  setLocalStatus,
  updateDraft,
  writeCommentsCache,
  writePrIndex,
  writePrMeta,
  type PrIndexFile,
} from '@meebox/poller';
import type { RepoIdentity } from '@meebox/repo-mirror';
import {
  AppError,
  ERROR_CODES,
  errorCodeMessage,
  parsePullRequestUrl,
  type PrComment,
  type StoredPullRequest,
} from '@meebox/shared';
import { annotateOwnership } from '../services/comments.js';
import { getContext } from '../services/context.js';
import type { IpcController } from './types.js';

/*
 * PR operation-domain controllers: comments / list / status / merge / mirror / diff / drafts
 */

/**
 * Reply to an existing comment; on success clear the comments cache + broadcast comments:changed so the UI re-fetches.
 */
export const replyComment: IpcController<'comments:reply'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const adapter = ctx.pr.adapterForOrThrow(pr);
  const reply = await adapter.comments.replyToComment(
    { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
    pr.remoteId,
    req.parentCommentId,
    req.body,
  );
  await ctx.pr.invalidateCommentsCache(pr.localId);
  return reply;
};

/**
 * Create a new summary (top-level, not file-anchored) comment on the PR; on success clear the comments cache + broadcast comments:changed so the UI re-fetches.
 */
export const createComment: IpcController<'comments:create'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const adapter = ctx.pr.adapterForOrThrow(pr);
  const created = await adapter.comments.publishSummaryComment(
    { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
    pr.remoteId,
    req.body,
  );
  await ctx.pr.invalidateCommentsCache(pr.localId);
  return created;
};

/**
 * Delete a remote comment authored by yourself (with a version optimistic lock). Failures are rethrown verbatim to the renderer; on success clear the cache + broadcast.
 */
export const deleteComment: IpcController<'comments:delete'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const adapter = ctx.pr.adapterForOrThrow(pr);
  await adapter.comments.deleteComment(
    { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
    pr.remoteId,
    req.commentId,
    req.version,
  );
  await ctx.pr.invalidateCommentsCache(pr.localId);
};

/**
 * Edit the body of a comment authored by yourself (with a version optimistic lock). The returned updated is only an optimistic reference; clear the cache + broadcast.
 */
export const editComment: IpcController<'comments:edit'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const adapter = ctx.pr.adapterForOrThrow(pr);
  const updated = await adapter.comments.editComment(
    { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
    pr.remoteId,
    req.commentId,
    req.version,
    req.body,
  );
  await ctx.pr.invalidateCommentsCache(pr.localId);
  return updated;
};

/**
 * Toggle the current user's emoji reaction on a comment (add / remove). On success clear the comments cache + broadcast comments:changed.
 */
export const toggleReaction: IpcController<'comments:toggleReaction'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const adapter = ctx.pr.adapterForOrThrow(pr);
  await adapter.comments.toggleReaction(
    { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
    pr.remoteId,
    req.commentId,
    req.kind,
    req.emoji,
    req.add,
  );
  await ctx.pr.invalidateCommentsCache(pr.localId);
};

/**
 * Upload an image as a comment attachment, returning markdown insertable into the body; unsupported platforms (GitHub) return null.
 * bytes come from the renderer via IPC as an ArrayBuffer, converted to Uint8Array here and handed to the adapter to upload. Does not clear the cache (only produces markdown,
 * the comment is not yet published).
 */
export const uploadAttachment: IpcController<'comments:uploadAttachment'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const adapter = ctx.pr.adapterForOrThrow(pr);
  return adapter.media.uploadAttachment(
    { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
    pr.remoteId,
    { fileName: req.fileName, contentType: req.contentType, bytes: new Uint8Array(req.bytes) },
  );
};

/**
 * Fetch a comment's embedded image (private instances need a PAT, the renderer cannot fetch it directly) → proxied through main back to a dataUrl. Not cached.
 */
export const fetchAttachment: IpcController<'comments:fetchAttachment'> = async (_event, req) => {
  try {
    const ctx = getContext();
    const pr = await ctx.pr.findPrOrThrow(req.localId);
    const adapter = ctx.pr.adapterFor(pr);
    if (!adapter) return null;
    // Pass pr.repo to the adapter — Bitbucket's attachment: protocol needs repo context to build the URL
    const res = await adapter.media.getAttachment(req.url, pr.repo);
    if (!res) return null;
    const base64 = Buffer.from(res.bytes).toString('base64');
    return { dataUrl: `data:${res.contentType};base64,${base64}` };
  } catch {
    return null;
  }
};

/**
 * Show only the current active connection's PRs (the state store may still hold historical PRs from other connections before the switch).
 */
export const listPrs: IpcController<'prs:list'> = async () => {
  const ctx = getContext();
  const activeId = ctx.bootstrap.config.active_connection_id;
  const all = await listStoredPullRequests(ctx.stateStore);
  return activeId ? all.filter((pr) => pr.connectionId === activeId) : all;
};

/**
 * List archived (exited) PRs: used by the "closed" view, read-only browsing. Also shows only the current active connection's entries.
 */
export const listArchivedPrs: IpcController<'prs:listArchived'> = async () => {
  const ctx = getContext();
  const activeId = ctx.bootstrap.config.active_connection_id;
  const all = await listArchivedPullRequests(ctx.stateStore, ctx.archiveStore);
  return activeId ? all.filter((pr) => pr.connectionId === activeId) : all;
};

/**
 * Open a PR of the current platform by URL (reviewing someone else's PR you were not formally asked to participate in):
 * ① Parse the link into {group,repo,remoteId}; if it doesn't match the current platform's shape → PR_URL_INVALID;
 * ② Look up the index by deterministic localId: if it already exists, return its scope (active / archived) so the frontend can locate it;
 * ③ Otherwise fetch the single PR from remote (auth: 403 → PR_FORBIDDEN, 404 → PR_NOT_FOUND), store it in the archive cold storage +
 *    write an index entry (archivedAt=now, cleaned up on grace expiry per the archive lifecycle); the repo mirror reuses the lazy pull done when opening details.
 */
export const openPrByUrl: IpcController<'prs:openByUrl'> = async (_event, req) => {
  const ctx = getContext();
  const activeId = ctx.bootstrap.config.active_connection_id;
  const built = activeId
    ? ctx.connectionRuntime.adapters.find((a) => a.connectionId === activeId)
    : undefined;
  if (!activeId || !built) {
    throw new AppError(ERROR_CODES.PR_NO_ACTIVE_CONNECTION, undefined, 'no active connection');
  }
  const adapter = built.adapter;
  const parsed = parsePullRequestUrl(adapter.kind, req.url);
  if (!parsed) {
    throw new AppError(ERROR_CODES.PR_URL_INVALID, undefined, 'not a PR url of active platform');
  }
  const identity = {
    platform: adapter.kind,
    connectionId: activeId,
    group: parsed.group,
    repo: parsed.repo,
    remoteId: parsed.remoteId,
  };
  const localId = prHashId(identity);

  // If known, locate directly (no re-fetch): active → 'active' (with its discovery filters, so the frontend lands on a tab that can show it), archived → 'archived'.
  const existing = (await readPrIndex(ctx.stateStore))?.prs[localId];
  if (existing) {
    if (existing.archivedAt) return { localId, location: 'archived', discoveryFilters: [] } as const;
    const meta = await readPrMeta(ctx.stateStore, localId);
    return { localId, location: 'active', discoveryFilters: meta?.pr.discoveryFilters ?? [] } as const;
  }

  // Remote fetch (auth). 403/404 normalize to error codes; other errors (network / 5xx) bubble up verbatim for the frontend to fall back on.
  let pr;
  try {
    pr = await adapter.prs.getSinglePullRequest(
      { projectKey: parsed.group, repoSlug: parsed.repo },
      parsed.remoteId,
    );
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    if (status === 403) throw new AppError(ERROR_CODES.PR_FORBIDDEN, undefined, 'forbidden');
    if (status === 404) throw new AppError(ERROR_CODES.PR_NOT_FOUND, undefined, 'not found');
    throw err;
  }

  // Store in the archive cold storage (managed / lifecycled the same as "closed"). Index entry archivedAt=now → auto-cleaned on grace expiry.
  const now = new Date().toISOString();
  const stored: StoredPullRequest = {
    ...pr,
    localId,
    platform: adapter.kind,
    connectionId: activeId,
    localStatus: 'pending',
    discoveryFilters: [],
    discoveredAt: now,
    lastSeenAt: now,
  };
  await writePrMeta(ctx.archiveStore, localId, stored);
  // Re-read the index right before writing for a read-modify-write, to minimize the race window with poll rewriting the index.
  const fresh = (await readPrIndex(ctx.stateStore)) ?? { schema_version: 1, prs: {} };
  const next: PrIndexFile = {
    schema_version: 1,
    prs: {
      ...fresh.prs,
      [localId]: {
        identity: { ...identity, url: pr.url },
        updatedAt: pr.updatedAt,
        discoveredAt: now,
        lastSeenAt: now,
        archivedAt: now,
      },
    },
  };
  await writePrIndex(ctx.stateStore, next);
  return { localId, location: 'archived', discoveryFilters: [] } as const;
};

/**
 * Immediately run one poll.
 */
export const refreshPrs: IpcController<'prs:refresh'> = () => getContext().poller.tick();

/**
 * The Poller's most recent completion time (used for startup initialization).
 */
export const getLastSync: IpcController<'prs:lastSync'> = () => ({
  at: getContext().poller.getLastPollAt(),
});

/**
 * Set review status: write remote first (on failure the frontend is unchanged), and persist locally after the remote is OK.
 */
export const setPrStatus: IpcController<'prs:setLocalStatus'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const adapter = ctx.pr.adapterForOrThrow(pr);
  const remoteStatus =
    req.status === 'approved'
      ? 'approved'
      : req.status === 'needs_work'
        ? 'needsWork'
        : 'unapproved';
  await adapter.prs.setPullRequestReviewStatus(
    { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
    pr.remoteId,
    remoteStatus,
  );
  return setLocalStatus(ctx.stateStore, req.localId, req.status);
};

/**
 * Mark a PR read: advance the read watermark + clear the unread flag (pure local state, no remote call).
 */
export const markRead: IpcController<'prs:markRead'> = (_event, req) =>
  markPrRead(getContext().stateStore, req.localId);

/**
 * Merge a PR; do not persist locally here, relying on renderer refresh → poll soft-delete to finish, to avoid local and remote disagreeing.
 */
export const mergePr: IpcController<'prs:merge'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const adapter = ctx.pr.adapterForOrThrow(pr);
  await adapter.prs.mergePullRequest(
    { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
    pr.remoteId,
  );
};

/**
 * Ensure the PR's repo mirror is in place (fast-path hit is a noop).
 */
export const syncRepo: IpcController<'repo:sync'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  return ctx.pr.ensureMirrorReadyForPr(pr);
};

/**
 * List changed files (ensure the mirror first). Defaults to all changes in PR merge-base..head; if base/head are passed, list that range
 * (e.g. a commit's parent..sha), used for "view a specific commit".
 */
export const listChangedFiles: IpcController<'diff:listChangedFiles'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const id = ctx.pr.repoIdentityFor(pr);
  await ctx.pr.ensureMirrorReadyForPr(pr);
  const base = req.base ?? (await ctx.pr.resolveDiffBaseSha(pr));
  const head = req.head ?? pr.sourceRef.sha;
  return ctx.repoMirror.listChangedFiles(id, base, head);
};

/**
 * List files that would conflict on merge (the file tree marks a triangle warning from this). Only when the remote judges the PR has a conflict (pr.hasConflict) does it actually run
 * a local merge-tree trial merge — target branch tip ⟂ source head; a conflict-free PR returns empty directly, saving a trial merge.
 */
export const listConflictFiles: IpcController<'diff:listConflictFiles'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  if (!pr.hasConflict) return [];
  const id = ctx.pr.repoIdentityFor(pr);
  await ctx.pr.ensureMirrorReadyForPr(pr);
  return ctx.repoMirror.listConflictFiles(id, pr.targetRef.sha, pr.sourceRef.sha);
};

/**
 * Read the file content on the base / head side. Defaults to PR merge-base / head; if base/head are passed, use the specified range
 * (commit view: base=parent, head=commit).
 */
export const getFileContent: IpcController<'diff:getFileContent'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const id = ctx.pr.repoIdentityFor(pr);
  const sha =
    req.side === 'base'
      ? (req.base ?? (await ctx.pr.resolveDiffBaseSha(pr)))
      : (req.head ?? pr.sourceRef.sha);
  return ctx.repoMirror.getFileContent(id, sha, req.path);
};

/**
 * Read only the comment cache count (lazy display for the tab badge), without hitting remote.
 */
export const getCommentCountCached: IpcController<'diff:commentCountCached'> = async (
  _event,
  req,
) => {
  const ctx = getContext();
  const cache = await readCommentsCache(await ctx.pr.storeForPr(req.localId), req.localId);
  if (!cache) return null;
  return { count: cache.comments.length };
};

// In-flight dedup: when opening a PR, multiple components call listComments(force:true) in parallel; merge into the same Promise so remote is hit only once.
const listCommentsInFlight = new Map<string, Promise<PrComment[]>>();

/**
 * Fetch comments: cache + pr_updated_at staleness comparison; force=true skips the cache. Dedups in-flight per localId.
 */
export const listComments: IpcController<'diff:listComments'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  // Route the per-PR cache by archive status (a closed PR's cache goes to archive storage, not the active store, to avoid being mistakenly deleted during reconciliation).
  const store = await ctx.pr.storeForPr(pr.localId);
  const cache = await readCommentsCache(store, pr.localId);
  if (!req.force && cache && !isCommentsCacheStale(cache, pr.updatedAt)) {
    return cache.comments;
  }
  const existing = listCommentsInFlight.get(pr.localId);
  if (existing) return existing;
  const adapter = ctx.pr.adapterForOrThrow(pr);
  // Dedup requires storing the in-flight Promise into the map **synchronously** before awaiting: so explicitly construct the Promise (using an async
  // IIFE that awaits in sequence) and set it, then return. It cannot be written as a direct await in a top-level async function body — before the first await suspends,
  // the Promise is not yet registered in the map, so concurrent requests falling in that window would each hit remote again. .finally is bound on the Promise for
  // cleanup (independent of the specific awaiter; removes the map entry on both success and failure).
  const fetchPromise = (async () => {
    const raw = await adapter.comments.listPullRequestComments(
      { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
      pr.remoteId,
    );
    const fresh = annotateOwnership(raw, adapter);
    await writeCommentsCache(store, pr.localId, {
      comments: fresh,
      pr_updated_at: pr.updatedAt,
      fetched_at: new Date().toISOString(),
    });
    return fresh;
  })().finally(() => {
    listCommentsInFlight.delete(pr.localId);
  });
  listCommentsInFlight.set(pr.localId, fetchPromise);
  return fetchPromise;
};

/**
 * Fetch commits (not cached, small volume + fetched only when entering the commits tab / activity timeline).
 *
 * The platform `/commits` endpoint returns the full `target..source` set — long-lived branches / fork-sync branches repeatedly
 * merge other branches into the source branch over their history, dragging in many merge commits and other people's merged-in commits, drowning out the commits this PR truly introduced. Here the local
 * mirror computes the "PR's own commits" SHA set along the first-parent trunk for intersection filtering (same criterion as the commit-count badge, see
 * {@link RepoMirrorManager.listIntroducedCommitShas}). If the mirror is not in place / cannot be computed → fall back to the unfiltered platform list,
 * at least losing no information.
 */
export const listCommits: IpcController<'diff:listCommits'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const adapter = ctx.pr.adapterForOrThrow(pr);
  const remote = await adapter.prs.listPullRequestCommits(
    { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
    pr.remoteId,
  );
  try {
    const id = ctx.pr.repoIdentityFor(pr);
    await ctx.pr.ensureMirrorReadyForPr(pr);
    const base = await ctx.pr.resolveDiffBaseSha(pr);
    const introduced = await ctx.repoMirror.listIntroducedCommitShas(id, base, pr.sourceRef.sha);
    if (introduced === null) return remote;
    const keep = new Set(introduced);
    return remote.filter((c) => keep.has(c.sha));
  } catch (err) {
    ctx.logger.warn(
      { err, localId: pr.localId },
      'listCommits: first-parent filter failed; returning unfiltered platform list',
    );
    return remote;
  }
};

/**
 * Fetch review-decision activity events (approve / needs-work / unapprove / dismiss). Not cached, small volume;
 * merged with comments / commits when entering the activity timeline. When the platform cannot retrieve historical decisions, the adapter returns [].
 */
export const listActivity: IpcController<'diff:listActivity'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const adapter = ctx.pr.adapterForOrThrow(pr);
  return adapter.prs.listPullRequestActivity(
    { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
    pr.remoteId,
  );
};

/**
 * Local git computes the PR's introduced commit count (base=merge-base, first-parent trunk criterion, consistent with the listCommits filter set,
 * excluding merged-in target commits and other people's commits dragged in by historical merges); returns null if the mirror is not complete.
 */
export const getCommitCount: IpcController<'diff:commitCount'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const id = ctx.pr.repoIdentityFor(pr);
  const base = await ctx.pr.resolveDiffBaseSha(pr);
  const n = await ctx.repoMirror.countCommits(id, base, pr.sourceRef.sha);
  return n === null ? null : { count: n };
};

/**
 * head-side blame; PR-introduced lines are returned separately for BlameColumn to draw color-band placeholders.
 */
export const getBlame: IpcController<'diff:getBlame'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const id = ctx.pr.repoIdentityFor(pr);
  const base = req.base ?? (await ctx.pr.resolveDiffBaseSha(pr));
  const head = req.head ?? pr.sourceRef.sha;
  const [allBlame, changedSet] = await Promise.all([
    ctx.repoMirror.getBlame(id, head, req.path),
    ctx.repoMirror.listChangedHeadLines(id, base, head, req.path),
  ]);
  return {
    lines: allBlame.filter((b) => !changedSet.has(b.line)),
    changedLines: Array.from(changedSet).sort((a, b) => a - b),
  };
};

/**
 * Total bytes used by all local repo mirrors (deduped by host|projectKey|repoSlug).
 */
export const getTotalSize: IpcController<'repo:getTotalSize'> = async () => {
  const ctx = getContext();
  const prs = await listStoredPullRequests(ctx.stateStore);
  const seen = new Set<string>();
  let total = 0;
  for (const pr of prs) {
    let id: RepoIdentity;
    try {
      id = ctx.pr.repoIdentityFor(pr);
    } catch {
      continue;
    }
    const key = `${id.host}|${id.projectKey}|${id.repoSlug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = await ctx.repoMirror.getSize(id);
    total += r.totalBytes;
  }
  return { totalBytes: total };
};

/**
 * List all of a PR's drafts.
 */
export const getDrafts: IpcController<'drafts:list'> = async (_event, req) => {
  const ctx = getContext();
  return listDrafts(await ctx.pr.storeForPr(req.localId), req.localId);
};

/**
 * Create a draft; the IPC boundary enforces the origin/source constraint again to keep dirty data off disk.
 */
export const addDraft: IpcController<'drafts:create'> = async (_event, req) => {
  const ctx = getContext();
  const { draft, localId } = req;
  if (draft.origin === 'finding' && !draft.source) {
    throw new Error('drafts:create: origin=finding requires source { runId, findingId }');
  }
  if (draft.origin === 'manual' && draft.source) {
    throw new Error('drafts:create: origin=manual must not pass source');
  }
  const created = await createDraft(await ctx.pr.storeForPr(localId), localId, draft);
  ctx.broadcast('drafts:changed', { localId });
  return created;
};

/**
 * Partially update a draft (editing a pending body auto-transitions it to edited; returns null if not found).
 */
export const patchDraft: IpcController<'drafts:update'> = async (_event, req) => {
  const ctx = getContext();
  const store = await ctx.pr.storeForPr(req.localId);
  const updated = await updateDraft(store, req.localId, req.draftId, req.patch);
  if (updated) ctx.broadcast('drafts:changed', { localId: req.localId });
  return updated;
};

/**
 * Delete a draft.
 */
export const removeDraft: IpcController<'drafts:delete'> = async (_event, req) => {
  const ctx = getContext();
  await deleteDraft(await ctx.pr.storeForPr(req.localId), req.localId, req.draftId);
  ctx.broadcast('drafts:changed', { localId: req.localId });
};

/** finding closure relations: list all for this PR (closure records where a re-review /ask supersedes/revokes the original finding). */
export const getFindingClosures: IpcController<'findingClosures:list'> = async (_event, req) => {
  const ctx = getContext();
  return listFindingClosures(await ctx.pr.storeForPr(req.localId), req.localId);
};

/** Record a closure relation (the re-review card's "adopt and close original / close original" action); broadcast so finding cards re-fetch and switch to the closed state. */
export const addClosure: IpcController<'findingClosures:create'> = async (_event, req) => {
  const ctx = getContext();
  const created = await addFindingClosure(await ctx.pr.storeForPr(req.localId), req.localId, {
    runId: req.runId,
    findingId: req.findingId,
    byAskRunId: req.byAskRunId,
    verdict: req.verdict,
  });
  ctx.broadcast('findingClosures:changed', { localId: req.localId });
  return created;
};

/** Revoke a closure (the finding card's "undo close" action). */
export const removeClosure: IpcController<'findingClosures:delete'> = async (_event, req) => {
  const ctx = getContext();
  await removeFindingClosure(
    await ctx.pr.storeForPr(req.localId),
    req.localId,
    req.runId,
    req.findingId,
  );
  ctx.broadcast('findingClosures:changed', { localId: req.localId });
};

/**
 * Batch-publish drafts: publishInlineComment one by one, a single failure does not interrupt; on success delete the local draft.
 * After the whole batch runs, broadcast drafts:changed; if any succeeded, force-refresh comments + broadcast comments:changed.
 */
export const publishDraftBatch: IpcController<'drafts:publishBatch'> = async (_event, req) => {
  const ctx = getContext();
  const pr = await ctx.pr.findPrOrThrow(req.localId);
  const adapter = ctx.pr.adapterForOrThrow(pr);
  const store = await ctx.pr.storeForPr(req.localId);

  // Fetch the current draft pool once: localId → id → draft, avoiding O(N²) IO from repeated listDrafts in the loop
  const allDrafts = await listDrafts(store, req.localId);
  const draftById = new Map(allDrafts.map((d) => [d.id, d]));

  const results: { draftId: string; ok: boolean; postedRemoteId?: string; error?: string }[] = [];
  let anyPublished = false;
  for (const draftId of req.draftIds) {
    const draft = draftById.get(draftId);
    if (!draft) {
      results.push({ draftId, ok: false, error: errorCodeMessage(ERROR_CODES.PR_DRAFT_NOT_FOUND) });
      continue;
    }
    // rejected is not sent (the user decided not to send). posted is not guarded: on successful publish the local draft is deleted, no historical posted state is kept.
    if (draft.status === 'rejected') {
      results.push({ draftId, ok: false, error: errorCodeMessage(ERROR_CODES.PR_DRAFT_REJECTED) });
      continue;
    }
    try {
      // ReviewDraftAnchor → PrCommentAnchor: side maps conservatively new→added / old→removed;
      // multi-line lands on endLine (the comment appears below the annotated range, not interrupting top-down reading). Hitting a context line
      // makes Bitbucket return 400; the error is collected into results for the user to see.
      const posted = await adapter.comments.publishInlineComment(
        { projectKey: pr.repo.projectKey, repoSlug: pr.repo.repoSlug },
        pr.remoteId,
        {
          path: draft.anchor.path,
          line: draft.anchor.endLine,
          side: draft.anchor.side,
          lineType: draft.anchor.side === 'old' ? 'removed' : 'added',
        },
        draft.body,
      );
      // Successful publish = the local draft's mission is done, delete it directly (the remote comment is pulled back and takes over display via the force-refresh below).
      await deleteDraft(store, req.localId, draftId);
      anyPublished = true;
      results.push({ draftId, ok: true, postedRemoteId: posted.remoteId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.logger.warn(
        { localId: req.localId, draftId, err: msg },
        'drafts:publishBatch: single draft failed',
      );
      results.push({ draftId, ok: false, error: msg });
    }
  }

  ctx.broadcast('drafts:changed', { localId: req.localId });
  if (anyPublished) {
    await ctx.pr.invalidateCommentsCache(pr.localId);
  }
  return { results };
};
