import type { JsonFileStateStore } from '@meebox/state-store';
import { broadcast } from './broadcast.js';

/**
 * 清掉某 PR 的评论缓存并广播 `comments:changed`，让 CommentsPanel / DiffView 内嵌评论
 * 重拉刷新。收口 comments reply/delete/edit 与 drafts:publishBatch 共用的同一套链路
 * （清 `prs/<localId>/comments` 缓存 → 下次 listComments force 拉远端 → 广播触发重拉）。
 * cache miss 无所谓，吞掉异常。
 */
export async function invalidateCommentsCache(
  stateStore: JsonFileStateStore,
  localId: string,
): Promise<void> {
  try {
    await stateStore.delete(`prs/${localId}/comments`);
  } catch {
    /* cache miss 也无所谓 */
  }
  broadcast('comments:changed', { localId });
}
