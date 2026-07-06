import type { PlatformUser, PrComment, PrCommit } from '@meebox/shared';

/**
 * Collect a bounded, deduped `@mention` candidate set from data already loaded for a PR — comment authors
 * (including nested replies) + commit authors/committers, plus any explicitly seeded users (e.g. the PR author).
 * Deduped by `name`, order preserved (seeds first). No extra remote fetches, and only this PR's participants
 * are exposed (not an enumeration of all remote members); the user can still type any `@name` by hand.
 *
 * Shared by the activity timeline composer (comments + commits) and the inline diff draft editor (comments +
 * PR author) so both offer the same completion set.
 */
export function collectMentionCandidates(
  comments: readonly PrComment[],
  commits: readonly PrCommit[],
  seed: readonly PlatformUser[] = [],
): PlatformUser[] {
  const seen = new Set<string>();
  const out: PlatformUser[] = [];
  const push = (u: PlatformUser | undefined): void => {
    if (!u?.name || seen.has(u.name)) return;
    seen.add(u.name);
    out.push(u);
  };
  for (const u of seed) push(u);
  const walk = (list: readonly PrComment[]): void => {
    for (const c of list) {
      push(c.author);
      if (c.replies.length > 0) walk(c.replies);
    }
  };
  walk(comments);
  for (const cm of commits) {
    push(cm.author);
    push(cm.committer);
  }
  return out;
}
