import type { PrComment } from '@meebox/shared';
import type { StateStore } from '@meebox/state-store';

/**
 * PR comments snapshot file. Lives at `prs/<localId>/comments.json`.
 *
 * Staleness check: if `pr_updated_at` does not match the current PR meta's updatedAt it is considered stale,
 * requiring a re-fetch from remote + overwrite of this file. **Note that updatedAt does not bump with comments on all platforms**—on platforms with replies
 * (GitHub etc.) a new comment bumps it, but Bitbucket's updatedDate does not change with comments / replies (see poller.ts's
 * `commentCountIncludesReplies` logic). So when polling discovers a comment change the main process explicitly invalidates this cache + broadcasts
 * comments:changed (see apps/desktop main's invalidateCommentsCache), rather than relying on updatedAt to self-invalidate.
 */
export interface CommentsCacheFile {
  schema_version: 1;
  /** The PR meta's updatedAt value when this cache was written; the comparison target for the stale check */
  pr_updated_at: string;
  /** ISO time when this remote fetch completed, for troubleshooting */
  fetched_at: string;
  comments: PrComment[];
}

export function commentsCacheKey(localId: string): string {
  return `prs/${localId}/comments`;
}

export async function readCommentsCache(
  store: StateStore,
  localId: string,
): Promise<CommentsCacheFile | null> {
  return store.read<CommentsCacheFile>(commentsCacheKey(localId));
}

export async function writeCommentsCache(
  store: StateStore,
  localId: string,
  data: { comments: PrComment[]; pr_updated_at: string; fetched_at: string },
): Promise<void> {
  await store.write<CommentsCacheFile>(commentsCacheKey(localId), {
    schema_version: 1,
    ...data,
  });
}

/**
 * Whether the cache needs a re-fetch. null / pr_updated_at not matching the current one both count as stale.
 */
export function isCommentsCacheStale(
  cache: CommentsCacheFile | null,
  currentPrUpdatedAt: string,
): boolean {
  if (!cache) return true;
  return cache.pr_updated_at !== currentPrUpdatedAt;
}
