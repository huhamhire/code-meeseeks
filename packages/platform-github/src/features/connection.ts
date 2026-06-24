import type { PingResult, PlatformCapabilities, RepoRef } from '@meebox/shared';
import { BaseConnection, type ConnectionContext } from '@meebox/platform-core';
import type { GitHubClient } from '../client.js';
import type { GhUser } from '../types.js';

/** GitHub 连接领域：能力声明、ping（含 GHE 版本）、PAT/SSH clone URL。 */
export class GitHubConnection extends BaseConnection {
  readonly kind = 'github' as const;

  constructor(
    ctx: ConnectionContext,
    private readonly client: GitHubClient,
  ) {
    super(ctx);
  }

  /**
   * GitHub 能力：三态审批（APPROVE / REQUEST_CHANGES / dismiss）、行内多行评论；无评论乐观锁；
   * 合并否决项只能近似（mergeable_state，partial）；发现走 search 强限流。
   * 「解决线程 / suggestion 应用 / pending-review 成组」当前未实现 → 置 false（Phase 4 再开）。
   */
  capabilities(): PlatformCapabilities {
    return {
      reviewStatuses: ['approved', 'needsWork', 'unapproved'],
      inlineComments: true,
      inlineMultiline: true,
      commentOptimisticLock: false,
      commentHardBreaks: true,
      mergeVetoFidelity: 'partial',
      discoveryRateLimited: true,
      discoveryFilters: ['review-requested', 'created', 'assigned', 'mentioned'],
      resolvableThreads: false,
      suggestions: false,
      reviewGrouping: false,
      activityTimeline: true,
    };
  }

  async ping(): Promise<PingResult> {
    const { body: me, headers } = await this.client.getWithHeaders<GhUser>('/user');
    const user = { name: me.login, displayName: me.name ?? me.login, slug: me.login };
    this.setCurrentUser(user);
    const gheVersion = headers.get('x-github-enterprise-version');
    return {
      ok: true,
      serverVersion: gheVersion ?? 'github.com',
      user,
    };
  }

  async getCloneUrl(repo: RepoRef): Promise<string> {
    return this.client.getCloneUrl(repo, this.getCurrentUser()?.name);
  }
}
