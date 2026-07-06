/**
 * Platform-aligned `@mention` token formatting for comment bodies. The mention syntax differs by platform, so the
 * insertion form (used by the comment / reply / inline-draft editors' autocomplete) is centralized here rather than
 * hardcoded `@name` at each call site.
 */
import type { PlatformKind, PlatformUser } from './platform.js';

/** Whether an identifier is a "simple" mention token that needs no quoting (letters / digits / `_` / `-` only). */
function isSimpleMentionId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

/**
 * Format a user as an `@mention` token to insert into a comment body, per platform syntax. No trailing space is
 * added — the caller decides surrounding whitespace.
 *
 * - **Bitbucket Server / Data Center**: mentions resolve by username; when the username contains characters beyond
 *   `[A-Za-z0-9_-]` (notably a dot, e.g. `first.last`) the token must be double-quoted — `@"first.last"` — otherwise
 *   the server does not link it to the user (it renders as plain text and sends no notification).
 * - **GitHub / GitLab**: a bare `@username` is used as-is (their usernames never contain characters needing quoting).
 */
export function formatMention(platform: PlatformKind, user: Pick<PlatformUser, 'name'>): string {
  const id = user.name;
  if (platform === 'bitbucket-server' && !isSimpleMentionId(id)) {
    return `@"${id}"`;
  }
  return `@${id}`;
}
