import type { PlatformUser, RepoRef } from '@meebox/shared';
import type { GlUser } from './types.js';

/** GitLab user → 中性 PlatformUser。跨 PR / 评论领域共用。 */
export function mapUser(u: GlUser): PlatformUser {
  return {
    name: u.username,
    displayName: u.name ?? u.username,
    slug: u.username,
    avatarUrl: u.avatar_url ?? undefined,
  };
}

/** GitLab 端点 `:id`：RepoRef 的 `projectKey/repoSlug`（含嵌套 group）URL-encode 成单段路径。 */
export function projectId(repo: RepoRef): string {
  return encodeURIComponent(`${repo.projectKey}/${repo.repoSlug}`);
}
