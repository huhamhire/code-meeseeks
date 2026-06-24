import type { PlatformUser } from '@meebox/shared';
import type { GhUser } from './types.js';

/** GitHub user → 中性 PlatformUser。跨 PR / 评论领域共用，故留在共享模块。 */
export function mapUser(u: GhUser): PlatformUser {
  return { name: u.login, displayName: u.name ?? u.login, slug: u.login, avatarUrl: u.avatar_url };
}
