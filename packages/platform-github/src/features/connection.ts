import type { PingResult, PlatformCapabilities, PlatformUser, RepoRef } from '@meebox/shared';
import { BaseConnection, type ConnectionContext } from '@meebox/platform-core';
import { GitHubClientError, type GitHubClient } from '../client.js';
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
      // GitHub exposes the repo collaborators list, so the mention editor can search repo-permitted users beyond this PR's participants.
      userSearch: true,
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

  /**
   * Search users for `@mention` autocomplete, **repo-scoped when the caller is privileged enough**. GitHub has no
   * repo-scoped user *search* endpoint, so we first list collaborators (`/repos/{owner}/{repo}/collaborators`, the people
   * with repo access) and filter client-side by login / name substring — but that endpoint needs **push access**, so a
   * read-only reviewer gets 403. On that auth failure we fall back to the global `/search/users` (callable by any
   * authenticated user), so mention search still works for everyone; only the scoping widens to "anyone on GitHub".
   * Capped at 20. Non-auth errors propagate (the controller degrades them to the local menu).
   */
  async searchUsers(query: string, repo: RepoRef): Promise<PlatformUser[]> {
    const raw = query.trim();
    if (!raw) return [];
    const toUser = (u: GhUser): PlatformUser => ({
      name: u.login,
      displayName: u.name ?? u.login,
      slug: u.login,
      avatarUrl: u.avatar_url,
    });
    try {
      const q = raw.toLowerCase();
      const list = await this.client.get<GhUser[]>(
        `/repos/${repo.projectKey}/${repo.repoSlug}/collaborators`,
        { per_page: '100' },
      );
      return list
        .filter((u) => u.login.toLowerCase().includes(q) || (u.name ?? '').toLowerCase().includes(q))
        .slice(0, 20)
        .map(toUser);
    } catch (e) {
      if (!(e instanceof GitHubClientError) || (e.status !== 401 && e.status !== 403)) throw e;
      // No push access → fall back to the global user search (any authenticated user can call it).
      const res = await this.client.get<{ items: GhUser[] }>('/search/users', {
        q: raw,
        per_page: '20',
      });
      return res.items.map(toUser);
    }
  }
}
