import type {
  LocalPrStatus,
  PlatformKind,
  PrDiscoveryFilter,
  ReviewerStatus,
  StoredPullRequest,
} from '@meebox/shared';

/**
 * PR 列表视图项：`GET /prs` 对外暴露的**精简投影**。这是「请求接口视图层的树结构约束方法」——
 * 单一投影函数 {@link toPrListItem} 定义列表返回的字段集合与次序，避免直接把整条
 * StoredPullRequest（含 description 明细、完整人员对象等）泄给列表消费方。
 *
 * 收窄原则：
 * - 只给标识与概览，**去掉 description 明细**（详情走 `GET /prs/{id}`）；
 * - **人员信息只留 slug**（reviewer 另带 status）；头像 / 展示名等留给详情；
 * - **字段顺序即输出顺序**：id / title / author / createdAt 优先，再给其余概览字段。
 */
export interface PrListItem {
  /** PR 的本地稳定标识（== StoredPullRequest.localId）；写操作与详情端点均按此定位。 */
  id: string;
  title: string;
  /** 作者 slug（缺失时回退 name）；不含展示名 / 头像。 */
  author: string;
  createdAt: string;
  /** 本人评审决断（pending / approved / needs_work）。 */
  status: LocalPrStatus;
  state: 'open' | 'merged' | 'declined';
  draft: boolean;
  platform: PlatformKind;
  /** `projectKey/repoSlug`。 */
  repo: string;
  /** 远端平台 PR 编号。 */
  remoteId: string;
  updatedAt: string;
  hasConflict: boolean;
  /** 远端判定可直接合并（== mergeStatus.canMerge）。 */
  mergeable: boolean;
  /** 命中的发现分类（一级 category）。 */
  categories: PrDiscoveryFilter[];
  /** 评审人：仅 slug + status。 */
  reviewers: Array<{ slug: string; status: ReviewerStatus }>;
  unread: boolean;
  unreadMentionCount: number;
}

/** 把存储态 PR 投影为列表视图项。对象字面量的键序即 JSON 输出顺序（CLI 视图层据此渲染）。 */
export function toPrListItem(pr: StoredPullRequest): PrListItem {
  return {
    id: pr.localId,
    title: pr.title,
    author: pr.author.slug ?? pr.author.name,
    createdAt: pr.createdAt,
    status: pr.localStatus,
    state: pr.state,
    draft: pr.draft,
    platform: pr.platform,
    repo: `${pr.repo.projectKey}/${pr.repo.repoSlug}`,
    remoteId: pr.remoteId,
    updatedAt: pr.updatedAt,
    hasConflict: pr.hasConflict,
    mergeable: pr.mergeStatus?.canMerge === true,
    categories: pr.discoveryFilters,
    reviewers: pr.reviewers.map((r) => ({ slug: r.slug ?? r.name, status: r.status })),
    unread: pr.unread ?? false,
    unreadMentionCount: pr.unreadMentionCount ?? 0,
  };
}
