// 复用 shared 中的契约类型（renderer 也会经 IPC 看到）。
export type { LocalPrStatus, PollResult, StoredPullRequest } from '@pr-pilot/shared';
import type { StoredPullRequest } from '@pr-pilot/shared';

/** state/pull-requests.json 的载荷形状（poller 内部使用）。 */
export interface PullRequestsIndexFile {
  schema_version: 1;
  pull_requests: StoredPullRequest[];
}

export const PR_INDEX_KEY = 'pull-requests';
