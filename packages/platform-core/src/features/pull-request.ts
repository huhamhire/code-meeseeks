import type {
  ListPendingOptions,
  PrActivityEvent,
  PrCommit,
  PullRequest,
  RepoRef,
  ReviewerStatus,
} from '@meebox/shared';
import { PlatformDomainService } from '../context.js';

/** PR 操作：发现、提交 / 活动数据、审批决断、合并。 */
export interface PullRequestService {
  /** 列出待处理 PR，跨项目跨仓库（默认 review-requested；GitHub 按 opts.filter 切换发现范围）。 */
  listPendingPullRequests(opts?: ListPendingOptions): Promise<PullRequest[]>;
  /** 列出 PR 全部提交，**newest first**。 */
  listPullRequestCommits(repo: RepoRef, prId: string): Promise<PrCommit[]>;
  /** 列出 PR 上的「评审决断」活动事件（approve / needs-work / unapprove / dismiss），带时间戳。 */
  listPullRequestActivity(repo: RepoRef, prId: string): Promise<PrActivityEvent[]>;
  /** 把当前用户在该 PR 上的 review 状态写到远端（approved / needsWork / unapproved）。 */
  setPullRequestReviewStatus(repo: RepoRef, prId: string, status: ReviewerStatus): Promise<void>;
  /** 合并 PR 到目标分支（仅应在 mergeStatus.canMerge=true 时调用；不可逆）。 */
  mergePullRequest(repo: RepoRef, prId: string): Promise<void>;
}

/** PR 操作领域基类。 */
export abstract class BasePullRequestService
  extends PlatformDomainService
  implements PullRequestService
{
  abstract listPendingPullRequests(opts?: ListPendingOptions): Promise<PullRequest[]>;
  abstract listPullRequestCommits(repo: RepoRef, prId: string): Promise<PrCommit[]>;
  abstract listPullRequestActivity(repo: RepoRef, prId: string): Promise<PrActivityEvent[]>;
  abstract setPullRequestReviewStatus(
    repo: RepoRef,
    prId: string,
    status: ReviewerStatus,
  ): Promise<void>;
  abstract mergePullRequest(repo: RepoRef, prId: string): Promise<void>;
}
