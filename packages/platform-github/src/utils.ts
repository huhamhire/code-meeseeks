import type { PlatformUser } from '@meebox/shared';
import type { GhUser } from './types.js';

/** GitHub user → neutral PlatformUser. Shared across the PR / comment domains, so it lives in the shared module. */
export function mapUser(u: GhUser): PlatformUser {
  return { name: u.login, displayName: u.name ?? u.login, slug: u.login, avatarUrl: u.avatar_url };
}
