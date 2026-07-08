import type {
  PingResult,
  PlatformCapabilities,
  PlatformUser,
  RepoRef,
  ReviewerStatus,
} from '@meebox/shared';
import { BaseConnection, type ConnectionContext } from '@meebox/platform-core';
import type { GitLabClient } from '../client.js';
import { mapUser, projectId } from '../utils.js';
import type { GlMetadata, GlUser, GlVersion } from '../types.js';

/** GitLab connection domain: capability declaration (degrade approval by edition), ping (with edition detection), PAT/SSH clone URL. */
export class GitLabConnection extends BaseConnection {
  readonly kind = 'gitlab' as const;

  constructor(
    ctx: ConnectionContext,
    private readonly client: GitLabClient,
  ) {
    super(ctx);
  }

  /**
   * GitLab capabilities: approval is binary (approve/unapprove, no "request changes" → no needsWork), and the API only exists
   * from Premium up → degrade by edition (CE/EE-Free empty + UI greyed-out); single-line inline comments; no comment optimistic lock; merge vetoes full
   * fidelity (detailed_merge_status); discovery endpoint not rate-limited. "Resolve thread / suggestion / grouped submission" concepts exist but are currently unimplemented.
   */
  capabilities(): PlatformCapabilities {
    const reviewStatuses: ReadonlyArray<ReviewerStatus> = this.client.approvalsAvailable
      ? ['approved', 'unapproved']
      : [];
    return {
      reviewStatuses,
      inlineComments: true,
      // GitLab has no file-level diff-comment API (position_type is text/image only) → unsupported.
      fileLevelComments: false,
      inlineMultiline: false,
      commentOptimisticLock: false,
      // GitLab Award Emoji supports arbitrary emoji → free.
      commentReactions: 'free',
      commentAttachments: true,
      // GitLab comments use standard CommonMark (single \n = soft wrap/space), not hard-break.
      commentHardBreaks: false,
      mergeVetoFidelity: 'full',
      discoveryRateLimited: false,
      // GitLab MR list supports reviewer_username / author_username / assignee_username filters → three pagination categories.
      // No "mentioned" concept, so mentioned is not included (poller polls each category + union tags, renderer switches tabs).
      discoveryFilters: ['review-requested', 'created', 'assigned'],
      resolvableThreads: false,
      suggestions: false,
      reviewGrouping: false,
      // GitLab has no unified activity event source (CE has no approval, approval system note parsing is fragile) → the PR tab degrades to a pure comment view.
      activityTimeline: false,
      // user_notes_count includes replies (replies are also notes) → count changes reliably reflect replies, poller only scans when the count/update time changes.
      commentCountIncludesReplies: true,
      // GitLab exposes /projects/:id/users?search=, so the mention editor can search project members beyond this PR's participants.
      userSearch: true,
    };
  }

  /**
   * Probe the connection: fetch the current user into the cache, and detect edition via /metadata to decide approval availability.
   *
   * When /metadata is unavailable (old instances), fall back to /version and conservatively assume CE (no approval).
   */
  async ping(): Promise<PingResult> {
    const me = await this.client.get<GlUser>('/user');
    this.setCurrentUser(mapUser(me));
    let serverVersion = 'gitlab';
    try {
      // /metadata (15.2+) carries the enterprise flag, used for edition detection.
      const meta = await this.client.get<GlMetadata>('/metadata');
      serverVersion = meta.version;
      this.client.approvalsAvailable = meta.enterprise === true;
    } catch {
      // /metadata unavailable (old instances) → fall back to /version, conservatively assume CE (no approval).
      this.client.approvalsAvailable = false;
      try {
        const ver = await this.client.get<GlVersion>('/version');
        serverVersion = ver.version;
      } catch {
        /* keep the default string when /version can't be fetched either */
      }
    }
    return { ok: true, serverVersion, user: this.getCurrentUser() ?? undefined };
  }

  /**
   * Build the repo's git clone URL, embedding PAT credentials by current username (falls back to the credential-less form when there's no user).
   */
  async getCloneUrl(repo: RepoRef): Promise<string> {
    return this.client.getCloneUrl(repo, this.getCurrentUser()?.name);
  }

  /**
   * Search **project members** for `@mention` autocomplete via `/projects/:id/users?search=` (matches username / name;
   * the members-among-the-project set, i.e. users with access to the repo). Capped at 20 results; each is mapped to the
   * neutral PlatformUser via {@link mapUser}. Callable by any project member (no elevated permission needed).
   */
  async searchUsers(query: string, repo: RepoRef): Promise<PlatformUser[]> {
    const q = query.trim();
    if (!q) return [];
    const users = await this.client.get<GlUser[]>(`/projects/${projectId(repo)}/users`, {
      search: q,
      per_page: '20',
    });
    return users.map(mapUser);
  }
}
