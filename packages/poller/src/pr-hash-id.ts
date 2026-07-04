import crypto from 'node:crypto';
import type { PlatformKind } from '@meebox/shared';

/**
 * A PR's stable identity within meebox's state system. Platform-neutral fields, so that when M5 adds
 * GitHub / GitLab the same schema is reused directly, without each platform inventing its own names:
 *
 *   platform × connection × group × repo × remoteId
 *
 * Field semantics mapping (each platform aligned to the same abstraction):
 * | abstract  | Bitbucket Server | GitHub             | GitLab          |
 * |-----------|------------------|--------------------|-----------------|
 * | platform  | bitbucket-server | github             | gitlab          |
 * | group     | projectKey       | owner (org/user)   | namespace       |
 * | repo      | repoSlug         | name               | name            |
 * | remoteId  | PR id (numeric)  | PR number          | MR iid          |
 *
 * `connectionId` is a meebox-local identifier, matching the id the user gave a connection in config.yaml;
 * its role is "per-account/per-credential" (a user may have two internal Bitbucket accounts), complementing
 * the platform dimension (Bitbucket's same host across accounts also avoids id collisions via connectionId).
 *
 * `<connectionId>:<remoteId>` alone is not enough — Bitbucket PR ids increment per repository, so two
 * different repos under the same connection can readily collide on id (e.g. proj-A/repo-x#42 and proj-A/repo-y#42).
 *
 * `url` is a snapshot of the remote PR's full URL (optional), so offline scenarios can still jump / debug directly;
 * it does not participate in the hash.
 */
export interface PrIdentity {
  platform: PlatformKind;
  connectionId: string;
  group: string;
  repo: string;
  /** String form, matching the shape returned by the remote API (Bitbucket is a numeric PR id stringified) */
  remoteId: string;
  /** Remote PR URL snapshot; informational field only, does not participate in the hash */
  url?: string;
}

/**
 * Hash the PR identity into a fixed-length 12-char hex string, used as the localId / state directory name.
 *
 * Choosing 12 hex (~48 bit): a single user's usage is far below 2^24, so collision probability is still
 * negligible; yet much shorter than a full sha1 (40 chars), keeping directory listings / logs readable.
 *
 * Input normalization: use `|` as the separator (URL-safe + never appears in connection id / group / repo
 * / remote id). Any field containing `|` is treated as invalid input (the upper layer should block it); no
 * fallback substitution is done here, to avoid introducing collisions. `url` is not part of the hash source
 * (the URL may vary across different Bitbucket paths while the PR is still the same one).
 *
 * Hash source order: platform / connection / group / repo / remoteId — most stable fields first so the
 * prefix has discriminating power (prefix-match can still hit when debugging).
 */
export function prHashId(identity: PrIdentity): string {
  const canonical = [
    identity.platform,
    identity.connectionId,
    identity.group,
    identity.repo,
    identity.remoteId,
  ].join('|');
  return crypto.createHash('sha1').update(canonical, 'utf8').digest('hex').slice(0, 12);
}
