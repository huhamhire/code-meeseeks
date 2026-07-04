import type { LocalPrStatus, StoredPullRequest } from '@meebox/shared';
import type { StateStore } from '@meebox/state-store';
import type { PrIdentity } from './pr-hash-id.js';

/**
 * `state/prs/index.json` is solely responsible for "which hash localIds are currently known + status fields",
 * used for fast listing / departure decisions / soft-delete tracking. Full PR metadata (title / refs / reviewers
 * etc.) lives in `prs/<localId>/meta.json`.
 */
export interface PrIndexEntry {
  identity: PrIdentity;
  /** Mirror of remote PR.updatedAt, used for poll comparison */
  updatedAt: string;
  /**
   * Mirror of the remote comment count ({@link PullRequest.commentCount}). poll compares against the prior round:
   * platforms whose count includes replies (GitHub/GitLab) use it to decide "there may be new comments" and thus
   * whether to scan; on Bitbucket (top-level only, excludes replies) this value is only auxiliary and insufficient
   * to determine replies. undefined when the platform does not provide it (poll falls back to judging by `updatedAt` alone).
   */
  commentCount?: number;
  /** Time first discovered by this machine's poll */
  discoveredAt: string;
  /** Time it most recently still appeared in the remote list */
  lastSeenAt: string;
  /**
   * Soft-delete timestamp: when a PR disappears from the remote reviewer pending list (merged / declined / you
   * are no longer a reviewer) → set to this poll's now. Cleared back to null when it reappears (reverse recovery).
   * The directory is only actually rm -r'd once archivedAt is older than PURGE_GRACE_MS.
   *
   * During the soft-delete window the UI does not display it (listStoredPullRequests filters it out), but runs
   * history / cache are all kept — in case the user looks back and wants to recover it.
   */
  archivedAt: string | null;
  /**
   * Monotonic cursor (ISO) of the latest "@me / reply-to-me" comment time. poll updates it to the larger value
   * after scanning comments when a PR's content changes (updatedAt jumps); on read it is compared against the read
   * watermark `lastReadAt` to derive mention unread. Maintained exclusively by poll (poll rewrites the whole index),
   * decoupled from the user's read watermark (stored separately in read-state.json), so poll's index rewrite does not
   * overwrite user actions.
   */
  lastMentionAt?: string;
  /**
   * List of createdAt (ISO) of "@me / reply-to-me" comments, keeping the most recent {@link MENTION_ATS_CAP} entries
   * (truncated in descending time order). poll dedupes against the historical union when scanning comments; on read
   * the unread count is computed by the read watermark (see computeUnreadMentionCount) — coexisting with the boolean
   * unread dot, not replacing it. Like `lastMentionAt`, maintained exclusively by poll, decoupled from the read watermark.
   */
  mentionAts?: string[];
  /**
   * Prior-round snapshots used for "PRs I authored" notifications (maintained exclusively by poll). Only when the PR
   * author is yourself are authored_* notifications produced from these; when the fields are missing (old index from
   * before the upgrade) the corresponding event is treated as "baseline" — only seeded, not backfilled, avoiding a
   * one-time flood of historical events after upgrade.
   */
  /** Prior round's merge-conflict state (== PullRequest.hasConflict); used to detect a false→true new conflict. */
  hasConflict?: boolean;
  /** Prior round's list of reviewer names in "needs work" state; used to detect newly appearing needs-work reviewers. */
  needsWorkReviewers?: string[];
  /** Prior round's known latest "others' comment" createdAt (ISO) cursor; others' comments later than it count as new. */
  lastCommentAt?: string;
}

/** mentionAts retention cap: keep only the most recent 10. The unread count is capped by this; UI shows "10+" when full. */
export const MENTION_ATS_CAP = 10;

/**
 * The user's "read watermark" for a single PR. Kept separately as `prs/<localId>/read-state.json` — written **only** by
 * markRead (the user opening the PR); poll's periodic rewrite of index.json never touches it, so the watermark the user
 * just advanced is not overwritten. Never written = the user has never opened that PR.
 */
export interface PrReadStateFile {
  schema_version: 1;
  /** Source branch head sha at the user's last view; a current head differing from it = new commit = unread */
  lastReadHeadSha: string;
  /** The user's last view time (ISO); @me / reply-to-me comments later than this = unread */
  lastReadAt: string;
}

export interface PrIndexFile {
  schema_version: 1;
  /** hash localId → entry. Object rather than Array: O(1) lookup + smaller JSON size */
  prs: Record<string, PrIndexEntry>;
}

export interface PrMetaFile {
  schema_version: 1;
  pr: StoredPullRequest;
}

/** Soft-delete retention period: 1 week. archived entries older than this are hard purged on the next poll */
export const PURGE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export const PR_INDEX_KEY = 'prs/index';

export function prMetaKey(localId: string): string {
  return `prs/${localId}/meta`;
}

export function prDirKey(localId: string): string {
  return `prs/${localId}`;
}

export function prReadStateKey(localId: string): string {
  return `prs/${localId}/read-state`;
}

export async function readPrReadState(
  store: StateStore,
  localId: string,
): Promise<PrReadStateFile | null> {
  return store.read<PrReadStateFile>(prReadStateKey(localId));
}

export async function writePrReadState(
  store: StateStore,
  localId: string,
  data: { lastReadHeadSha: string; lastReadAt: string },
): Promise<void> {
  await store.write<PrReadStateFile>(prReadStateKey(localId), { schema_version: 1, ...data });
}

export async function readPrIndex(store: StateStore): Promise<PrIndexFile | null> {
  return store.read<PrIndexFile>(PR_INDEX_KEY);
}

export async function writePrIndex(store: StateStore, file: PrIndexFile): Promise<void> {
  await store.write(PR_INDEX_KEY, file);
}

export async function readPrMeta(
  store: StateStore,
  localId: string,
): Promise<PrMetaFile | null> {
  return store.read<PrMetaFile>(prMetaKey(localId));
}

export async function writePrMeta(
  store: StateStore,
  localId: string,
  pr: StoredPullRequest,
): Promise<void> {
  await store.write<PrMetaFile>(prMetaKey(localId), { schema_version: 1, pr });
}

/**
 * Compute a PR's "unread" mark (derived, not persisted). Rules:
 * - **Never opened** (no read-state) → unread: covers new arrivals of "newly assigned / review requested of you", as well as PRs flooding in after clearing the directory / a fresh install.
 * - After being opened: the source head changed again (new commit), or an "@me / reply-to-me" comment appeared after the read time (`lastMentionAt > lastReadAt`) → unread.
 *
 * The read watermark (read-state) is written when the user opens the PR. Early dev builds do no upgrade compatibility — old backlog turning red is not suppressed (just clear the store / reinstall).
 */
export function computeUnread(
  entry: PrIndexEntry,
  readState: PrReadStateFile | null,
  pr: StoredPullRequest,
): boolean {
  if (!readState) return true;
  const commitUnread = pr.sourceRef.sha !== readState.lastReadHeadSha;
  const mentionUnread =
    entry.lastMentionAt != null && Date.parse(entry.lastMentionAt) > Date.parse(readState.lastReadAt);
  return commitUnread || mentionUnread;
}

/**
 * Compute the "@me / reply-to-me" unread count (derived, not persisted). **Coexists** with the boolean unread dot
 * (computeUnread): the unread dot still lights by new arrival / new commit / mention-reply, and this count only adds,
 * on top of that, the count of mentions/replies to you that are unread.
 *
 * Rules: take the mention timestamps accumulated in the index and count those later than the read watermark `lastReadAt`;
 * never opened (no read-state) → all are counted. The count is already capped on the poll side by {@link MENTION_ATS_CAP}
 * (at most 10), so the return value is naturally ≤ 10, and the UI shows "10+" when full.
 */
export function computeUnreadMentionCount(
  entry: PrIndexEntry,
  readState: PrReadStateFile | null,
): number {
  const ats = entry.mentionAts;
  if (!ats?.length) return 0;
  const water = readState ? Date.parse(readState.lastReadAt) : Number.NEGATIVE_INFINITY;
  let n = 0;
  for (const iso of ats) {
    if (Date.parse(iso) > water) n++;
  }
  return n;
}

/**
 * List currently **active** (non-soft-deleted) PRs.
 *
 * Implementation: read the index first → filter out those with a non-null archivedAt → read meta.json + read-state.json
 * one by one. meta not in the index but whose directory still exists is treated as an orphan and skipped (the poll
 * phase will clean it up).
 *
 * On return, an `unread` mark derived from the read watermark is layered onto each PR (meta.json itself does not store this field).
 */
export async function listStoredPullRequests(
  store: StateStore,
): Promise<StoredPullRequest[]> {
  const index = await readPrIndex(store);
  if (!index) return [];
  const out: StoredPullRequest[] = [];
  for (const [localId, entry] of Object.entries(index.prs)) {
    if (entry.archivedAt) continue;
    const meta = await readPrMeta(store, localId);
    if (!meta) continue;
    const readState = await readPrReadState(store, localId);
    out.push({
      ...meta.pr,
      unread: computeUnread(entry, readState, meta.pr),
      unreadMentionCount: computeUnreadMentionCount(entry, readState),
    });
  }
  return out;
}

/**
 * List **archived** (departed / soft-deleted) PRs, for browsing in the "Closed" view.
 *
 * The index is still maintained only in `stateStore` (a non-null archivedAt means archived); the PR entity directory is
 * moved as a whole tree into `archiveStore` cold storage on departure, so each meta is read from archiveStore. Entries
 * present in the index but with no meta in archiveStore (mid-migration / old layout) are skipped. Archived PRs are
 * always treated as read (not participating in unread derivation).
 */
export async function listArchivedPullRequests(
  stateStore: StateStore,
  archiveStore: StateStore,
): Promise<StoredPullRequest[]> {
  const index = await readPrIndex(stateStore);
  if (!index) return [];
  const out: StoredPullRequest[] = [];
  for (const [localId, entry] of Object.entries(index.prs)) {
    if (!entry.archivedAt) continue;
    const meta = await readPrMeta(archiveStore, localId);
    if (!meta) continue;
    out.push({ ...meta.pr, unread: false, unreadMentionCount: 0 });
  }
  return out;
}

/**
 * Mark a PR as read: advance the read watermark to the current head sha + now. Called via IPC when the user opens a PR.
 * Writes only read-state.json (not index.json), so it does not interfere with periodic poll's index rewrite. Returns null
 * when meta is not found; otherwise returns the latest PR with `unread:false`.
 */
export async function markPrRead(
  store: StateStore,
  localId: string,
  now: string = new Date().toISOString(),
): Promise<StoredPullRequest | null> {
  const meta = await readPrMeta(store, localId);
  if (!meta) return null;
  await writePrReadState(store, localId, {
    lastReadHeadSha: meta.pr.sourceRef.sha,
    lastReadAt: now,
  });
  return { ...meta.pr, unread: false, unreadMentionCount: 0 };
}

/**
 * Overwrite the localStatus of the given PR. The caller (IPC) usually PUTs to Bitbucket successfully first, then calls
 * this function so the local state reflects the new status immediately; the next poll will fetch the same value from
 * Bitbucket, producing no flicker.
 *
 * Returns null when meta is not found (the PR has departed / never existed).
 */
export async function setLocalStatus(
  store: StateStore,
  localId: string,
  localStatus: LocalPrStatus,
): Promise<StoredPullRequest | null> {
  const meta = await readPrMeta(store, localId);
  if (!meta) return null;
  const next: StoredPullRequest = { ...meta.pr, localStatus };
  await writePrMeta(store, localId, next);
  return next;
}
