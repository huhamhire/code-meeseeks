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

/** One mention found in a body: `[start, end)` are indices into the input, `name` excludes the `@` and any quotes. */
export interface FoundMention {
  start: number;
  end: number;
  name: string;
}

/**
 * Mention token, the reading counterpart of {@link formatMention} — both forms it can write must parse back here, which
 * is why the two live together: the quoted Bitbucket form is defined once, not once per direction.
 *
 * The leading boundary is deliberately narrow (start of input, whitespace, or an opening bracket) because `@` is common
 * in prose that is not a mention; requiring the boundary is what keeps `user@example.com` from matching its domain.
 */
const MENTION = /(^|[\s([{])@(?:"([^"\n]{1,64})"|([A-Za-z0-9_][A-Za-z0-9_.-]{0,63}))/g;

/**
 * Locate `@mention` tokens in a plain-text run, for rendering them distinctly from surrounding prose.
 *
 * **Syntactic, not resolved**: there is no authoritative local list of who exists on the remote (a mention may name
 * someone outside this PR's participants), so anything shaped like a mention is reported. Callers should therefore use
 * this for presentation only — a false positive that merely restyles a word is cheap, one that turned text into a link
 * or a notification would not be. The boundary rules exclude the common false positives anyway:
 *
 * - an email address (`user@example.com`) — the `@` has no leading boundary;
 * - a scoped package (`@scope/pkg`) — a `/` immediately after the name disqualifies it;
 * - a trailing `.` or `-` is treated as punctuation and left out of the name, so a mention ending a sentence is clean.
 *
 * Code spans are not a concern here: callers run this over text runs, and markdown code never reaches them.
 */
export function findMentions(text: string): FoundMention[] {
  const out: FoundMention[] = [];
  MENTION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION.exec(text)) !== null) {
    const lead = m[1] ?? '';
    const quoted = m[2];
    // A trailing `.` / `-` belongs to the surrounding prose, not to the username.
    const name = quoted ?? (m[3] ?? '').replace(/[.-]+$/, '');
    if (!name) continue;
    const start = m.index + lead.length;
    // `@` + name, plus the two quotes when quoted.
    const end = start + name.length + (quoted ? 3 : 1);
    MENTION.lastIndex = end;
    if (text[end] === '/') continue; // scoped package, not a mention
    out.push({ start, end, name });
  }
  return out;
}
