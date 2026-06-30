import type { PingResult, PlatformCapabilities, RepoRef, ReviewerStatus } from '@meebox/shared';
import { BaseConnection, type ConnectionContext } from '@meebox/platform-core';
import type { GitLabClient } from '../client.js';
import { mapUser } from '../utils.js';
import type { GlMetadata, GlUser, GlVersion } from '../types.js';

/** GitLab 连接领域：能力声明（按 edition 降级审批）、ping（含 edition 探测）、PAT/SSH clone URL。 */
export class GitLabConnection extends BaseConnection {
  readonly kind = 'gitlab' as const;

  constructor(
    ctx: ConnectionContext,
    private readonly client: GitLabClient,
  ) {
    super(ctx);
  }

  /**
   * GitLab 能力：审批二元（approve/unapprove，无 "request changes" → 不含 needsWork），且 Premium 起才有
   * API → 据 edition 降级（CE/EE-Free 空 + UI 灰显）；行内单行评论；无评论乐观锁；合并否决项 full
   * 保真（detailed_merge_status）；发现端点不强限流。「解决线程 / suggestion / 成组提交」概念有、当前未实现。
   */
  capabilities(): PlatformCapabilities {
    const reviewStatuses: ReadonlyArray<ReviewerStatus> = this.client.approvalsAvailable
      ? ['approved', 'unapproved']
      : [];
    return {
      reviewStatuses,
      inlineComments: true,
      inlineMultiline: false,
      commentOptimisticLock: false,
      // GitLab Award Emoji 支持任意 emoji → free。
      commentReactions: 'free',
      commentAttachments: true,
      // GitLab 评论走标准 CommonMark（单 \n = 软换行/空格），不按 hard-break。
      commentHardBreaks: false,
      mergeVetoFidelity: 'full',
      discoveryRateLimited: false,
      // GitLab MR 列表支持 reviewer_username / author_username / assignee_username 筛选 → 三类分页。
      // 没有 "mentioned" 概念，故不含 mentioned（poller 逐类轮询 + union 打标，renderer 切标签）。
      discoveryFilters: ['review-requested', 'created', 'assigned'],
      resolvableThreads: false,
      suggestions: false,
      reviewGrouping: false,
      // GitLab 无统一活动事件源（CE 无审批、审批系统 note 解析脆弱）→ PR 标签页退化为纯评论视图。
      activityTimeline: false,
      // user_notes_count 含回复（回复也是 note）→ 计数变化可靠反映回复，poller 仅在计数/更新时间变化时扫。
      commentCountIncludesReplies: true,
    };
  }

  /**
   * 探测连接：取当前用户落地缓存，并经 /metadata 探测 edition 以决定审批可用性。
   *
   * /metadata 不可用（旧实例）时退 /version 并保守置为 CE（无审批）。
   */
  async ping(): Promise<PingResult> {
    const me = await this.client.get<GlUser>('/user');
    this.setCurrentUser(mapUser(me));
    let serverVersion = 'gitlab';
    try {
      // /metadata（15.2+）带 enterprise 标志，用于 edition 探测。
      const meta = await this.client.get<GlMetadata>('/metadata');
      serverVersion = meta.version;
      this.client.approvalsAvailable = meta.enterprise === true;
    } catch {
      // /metadata 不可用（旧实例）→ 退 /version，保守置 CE（无审批）。
      this.client.approvalsAvailable = false;
      try {
        const ver = await this.client.get<GlVersion>('/version');
        serverVersion = ver.version;
      } catch {
        /* /version 也拿不到时保留默认串 */
      }
    }
    return { ok: true, serverVersion, user: this.getCurrentUser() ?? undefined };
  }

  /**
   * 构造仓库的 git clone URL，按当前用户名内嵌 PAT 凭据（无用户时退无凭据形式）。
   */
  async getCloneUrl(repo: RepoRef): Promise<string> {
    return this.client.getCloneUrl(repo, this.getCurrentUser()?.name);
  }
}
