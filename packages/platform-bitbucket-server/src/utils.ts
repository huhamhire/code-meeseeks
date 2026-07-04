import type { PlatformUser } from '@meebox/shared';
import type { BitbucketUser } from './types.js';

/**
 * Bitbucket user → neutral PlatformUser.
 *
 * Shared across the PR / comment domains, so it stays in the shared module.
 */
export function mapUser(u: BitbucketUser): PlatformUser {
  return { name: u.name, displayName: u.displayName, slug: u.slug };
}
