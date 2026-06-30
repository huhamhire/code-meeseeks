import type { PrComment } from '@meebox/shared';
import type { StateStore } from '@meebox/state-store';

/**
 * PR 评论快照文件。落在 `prs/<localId>/comments.json`。
 *
 * 失效判定：`pr_updated_at` 跟当前 PR meta 的 updatedAt 不一致即视为 stale，
 * 需要重新从远端拉 + 覆写本文件。**注意 updatedAt 并非对所有平台都随评论跳**——含回复的平台
 * （GitHub 等）新评论会跳，但 Bitbucket 的 updatedDate 不随评论 / 回复变化（见 poller.ts 的
 * `commentCountIncludesReplies` 逻辑）。故轮询发现评论变更时由主进程显式失效本缓存 + 广播
 * comments:changed（见 apps/desktop main 的 invalidateCommentsCache），不依赖 updatedAt 自失效。
 */
export interface CommentsCacheFile {
  schema_version: 1;
  /** 写入本缓存时 PR meta 的 updatedAt 值；stale 判定的对比目标 */
  pr_updated_at: string;
  /** 本次远端拉取完成的 ISO 时间，便于排障 */
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
 * 缓存是否需要重拉。null / pr_updated_at 跟当前不一致都算 stale。
 */
export function isCommentsCacheStale(
  cache: CommentsCacheFile | null,
  currentPrUpdatedAt: string,
): boolean {
  if (!cache) return true;
  return cache.pr_updated_at !== currentPrUpdatedAt;
}
