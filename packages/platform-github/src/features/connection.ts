import type { PingResult, PlatformCapabilities, RepoRef } from '@meebox/shared';
import { BaseConnection, type ConnectionContext } from '@meebox/platform-core';
import type { GitHubClient } from '../client.js';
import type { GhUser } from '../types.js';

/** GitHub connection domain: capability declaration, ping (including GHE version), PAT/SSH clone URL. */
export class GitHubConnection extends BaseConnection {
  readonly kind = 'github' as const;

  constructor(
    ctx: ConnectionContext,
    private readonly client: GitHubClient,
  ) {
    super(ctx);
  }

  /**
   * GitHub capabilities: three-state approval (APPROVE / REQUEST_CHANGES / dismiss), inline multi-line comments; no comment optimistic lock;
   * merge vetoes can only be approximated (mergeable_state, partial); discovery goes through search with a hard rate limit.
   * "resolvable threads / suggestion apply / pending-review grouping" are currently unimplemented → set to false (to be enabled in Phase 4).
   */
  capabilities(): PlatformCapabilities {
    return {
      reviewStatuses: ['approved', 'needsWork', 'unapproved'],
      inlineComments: true,
      inlineMultiline: true,
      commentOptimisticLock: false,
      // GitHub Reactions API has only a fixed 8 kinds → fixed.
      commentReactions: 'fixed',
      // GitHub has no public comment attachment upload API (the web uses an undocumented private endpoint) → off, UI hides paste-upload.
      commentAttachments: false,
      commentHardBreaks: true,
      mergeVetoFidelity: 'partial',
      discoveryRateLimited: true,
      discoveryFilters: ['review-requested', 'created', 'assigned', 'mentioned'],
      resolvableThreads: false,
      suggestions: false,
      reviewGrouping: false,
      activityTimeline: true,
      // comments + review_comments include inline replies → count changes reliably reflect replies, the poller only scans when count/update time changes.
      commentCountIncludesReplies: true,
    };
  }

  /**
   * Probe the connection: fetch the current user to land the cache, and read the GHE version number from the response headers.
   *
   * On public github.com with no version header, serverVersion is recorded as 'github.com'.
   */
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

  /**
   * Construct the repository's git clone URL, embedding PAT credentials by the current username (falls back to a credential-less form when there is no user).
   */
  async getCloneUrl(repo: RepoRef): Promise<string> {
    return this.client.getCloneUrl(repo, this.getCurrentUser()?.name);
  }
}
