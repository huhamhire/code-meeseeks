import type { PlatformUser } from '@meebox/shared';
import type { BitbucketUser } from './types.js';

/**
 * Bitbucket user → 中性 PlatformUser。
 *
 * 跨 PR / 评论领域共用，故留在共享模块。
 */
export function mapUser(u: BitbucketUser): PlatformUser {
  return { name: u.name, displayName: u.displayName, slug: u.slug };
}
