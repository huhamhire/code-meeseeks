import {
  ERROR_CODES,
  errorCodeMessage,
  type PingResult,
  type PlatformCapabilities,
  type RepoRef,
} from '@meebox/shared';
import { BaseConnection, type ConnectionContext } from '@meebox/platform-core';
import type { BitbucketClient } from '../client.js';
import type { BitbucketApplicationProperties, BitbucketUser } from '../types.js';

/** Minimum supported Bitbucket Server version (key capabilities like multilineMarker start at 7.0). */
const MIN_VERSION: readonly [number, number, number] = [7, 0, 0];

/**
 * Bitbucket Server connection domain: capability declaration, connection probe (version floor + current user), PAT/SSH clone URL.
 */
export class BitbucketServerConnection extends BaseConnection {
  readonly kind = 'bitbucket-server' as const;

  constructor(
    ctx: ConnectionContext,
    private readonly client: BitbucketClient,
  ) {
    super(ctx);
  }

  /**
   * Bitbucket Server capabilities: tri-state approval, inline multiline comments, edit/delete optimistic lock, per-item vetoes (/merge vetoes).
   *
   * No concept of "resolvable thread / code suggestion / pending-review grouping"; dashboard discovery is not hard rate-limited;
   * dashboard supports role=REVIEWER/AUTHOR → provides two discovery kinds: "review requested / created by me".
   */
  capabilities(): PlatformCapabilities {
    return {
      reviewStatuses: ['approved', 'needsWork', 'unapproved'],
      inlineComments: true,
      inlineMultiline: true,
      commentOptimisticLock: true,
      // Comment emoji reactions since 7.x (minimum supported version is 7.0); emoticon supports any emoji → free.
      commentReactions: 'free',
      commentAttachments: true,
      commentHardBreaks: true,
      mergeVetoFidelity: 'full',
      discoveryRateLimited: false,
      discoveryFilters: ['review-requested', 'created'],
      resolvableThreads: false,
      suggestions: false,
      reviewGrouping: false,
      activityTimeline: true,
      // properties.commentCount only counts top-level comments, and updatedDate does not change with comments → no "includes replies" signal, so the poller falls back to scanning pending PRs every round.
      commentCountIncludesReplies: false,
    };
  }

  /**
   * Connection probe: read application-properties for the version, get the current user slug from the
   * X-AUSERNAME response header, then query displayName and cache it.
   *
   * When the version is below the hard floor ({@link MIN_VERSION}), ok=false with a reason; when /users/{slug}
   * fails, fall back to using the slug as displayName.
   */
  async ping(): Promise<PingResult> {
    const { body: props, headers } =
      await this.client.getWithHeaders<BitbucketApplicationProperties>(
        '/rest/api/1.0/application-properties',
      );

    // Get the current user from the X-AUSERNAME (slug) response header, then query /users/{slug} for displayName
    const slug = headers.get('x-ausername');
    if (slug) {
      try {
        const u = await this.client.get<BitbucketUser>(
          `/rest/api/1.0/users/${encodeURIComponent(slug)}`,
        );
        this.setCurrentUser({ name: u.name, displayName: u.displayName, slug: u.slug });
      } catch {
        // When /users/{slug} fails, fall back to using the slug as displayName
        this.setCurrentUser({ name: slug, displayName: slug, slug });
      }
    }

    const user = this.getCurrentUser() ?? undefined;
    const cmp = this.compareVersion(props.version, MIN_VERSION);
    if (cmp >= 0) {
      return { ok: true, serverVersion: props.version, user };
    }
    return {
      ok: false,
      serverVersion: props.version,
      user,
      // The backend does not assemble user-facing localized text: carry it as an error code + meta, and the frontend does i18n by code (errors.ECF0001).
      reason: errorCodeMessage(ERROR_CODES.CF_UNSUPPORTED_VERSION, {
        version: props.version,
        min: MIN_VERSION.join('.'),
      }),
    };
  }

  /**
   * Construct the repository's git clone URL (PAT embeds the current username / ssh scp-like, split by the connection's clone protocol).
   */
  async getCloneUrl(repo: RepoRef): Promise<string> {
    return this.client.getCloneUrl(repo, this.getCurrentUser()?.name);
  }

  /**
   * Compare version numbers: segment-by-segment numeric comparison of `actual` against the minimum requirement, returning positive/zero/negative for ≥ / = / <.
   *
   * Non-numeric segments are treated as 0, tolerating suffixes like `7.21.0-build`.
   */
  private compareVersion(actual: string, min: readonly [number, number, number]): number {
    const parts = actual.split('.').map((s) => Number.parseInt(s, 10));
    for (let i = 0; i < min.length; i++) {
      const a = Number.isNaN(parts[i] ?? 0) ? 0 : (parts[i] ?? 0);
      const m = min[i] ?? 0;
      if (a !== m) return a - m;
    }
    return 0;
  }
}
