import type { PlatformUser, RepoRef } from '@meebox/shared';
import type { GlUser } from './types.js';

/** GitLab user → neutral PlatformUser. Shared across the PR / comment domains. */
export function mapUser(u: GlUser): PlatformUser {
  return {
    name: u.username,
    displayName: u.name ?? u.username,
    slug: u.username,
    avatarUrl: u.avatar_url ?? undefined,
  };
}

/** GitLab endpoint `:id`: RepoRef's `projectKey/repoSlug` (including nested group) URL-encoded into a single path segment. */
export function projectId(repo: RepoRef): string {
  return encodeURIComponent(`${repo.projectKey}/${repo.repoSlug}`);
}
