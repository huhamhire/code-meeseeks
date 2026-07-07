import type {
  PingResult,
  PlatformCapabilities,
  PlatformKind,
  PlatformUser,
  RepoRef,
} from '@meebox/shared';
import { PlatformDomainService } from '../context.js';

/** Connection / identity / clone (root domain): connection probe, current-user cache, capability aggregation entry, git clone URL. */
export interface PlatformConnection {
  readonly kind: PlatformKind;

  /**
   * Platform capability descriptor (static, fixed per platform/version/plan).
   *
   * Aggregated from each domain's capability declarations, and refined by connection probe results.
   */
  capabilities(): PlatformCapabilities;

  /**
   * Connection probe: returns the server version number and current user.
   *
   * When the version is below the hard minimum, ok=false with a reason.
   */
  ping(): Promise<PingResult>;

  /**
   * Return the user owning the current PAT, cached during ping; returns null if not ready.
   *
   * Synchronous method, only reads the cache, makes no request.
   */
  getCurrentUser(): PlatformUser | null;

  /**
   * Inject / restore the current-user cache.
   *
   * main pre-warms with locally persisted identity when establishing the connection, overwritten by the remote result after ping completes.
   */
  setCurrentUser?(user: PlatformUser | null): void;

  /**
   * Return the git clone URL (with PAT embedded as user:PAT or ssh scp-like form).
   */
  getCloneUrl(repo: RepoRef): Promise<string>;

  /**
   * Search users **with access to the given repo** by a free-text query (for `@mention` autocomplete), returning a
   * bounded list ordered by platform relevance. Repo-scoped (not a global directory search): each platform hits its
   * repo-permission endpoint (Bitbucket repo `permissions/users`, GitHub `collaborators`, GitLab project `users`), so
   * suggestions are people who can actually act on the PR. Backs the mention editor's remote fallback; only meaningful
   * when the `userSearch` capability is true. Implementations cap the result count; a "no match" resolves to an empty
   * array. (Some endpoints require elevated permission — e.g. Bitbucket repo-admin; on such failure the caller degrades
   * to the local candidate menu, see docs/arch/01-platform/04-comment-interactions.md.)
   */
  searchUsers(query: string, repo: RepoRef): Promise<PlatformUser[]>;
}

/**
 * Connection domain base class: current-user cache read/write is a cross-platform shared implementation; ping / capabilities / clone are implemented by platform subclasses.
 */
export abstract class BaseConnection extends PlatformDomainService implements PlatformConnection {
  abstract readonly kind: PlatformKind;

  /**
   * Declared by platform subclasses: this platform's capability descriptor (approval model, inline comments, merge-veto fidelity, etc.).
   */
  abstract capabilities(): PlatformCapabilities;

  /**
   * Connection probe implemented by platform subclasses: fetch the server version and current user, and populate the user cache.
   */
  abstract ping(): Promise<PingResult>;

  /**
   * Read the current user cached in the shared context; returns null if not ready.
   */
  getCurrentUser(): PlatformUser | null {
    return this.ctx.getCurrentUser();
  }

  /**
   * Write the current-user cache in the shared context.
   */
  setCurrentUser(user: PlatformUser | null): void {
    this.ctx.setCurrentUser(user);
  }

  /**
   * Implemented by platform subclasses: construct a directly cloneable git URL from a repo reference.
   */
  abstract getCloneUrl(repo: RepoRef): Promise<string>;

  /**
   * Implemented by platform subclasses: query the platform's repo-permission endpoint for `@mention` autocomplete.
   */
  abstract searchUsers(query: string, repo: RepoRef): Promise<PlatformUser[]>;
}
