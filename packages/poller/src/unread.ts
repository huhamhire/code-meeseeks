import type { PlatformUser, PrComment, PrCommentAnchor } from '@meebox/shared';

/**
 * Pure logic for "unread" detection: find, in the PR comment tree, the timestamp of the latest comment by others that is **relevant to the current user**.
 * Relevant = ① the body @mentions me (matched by name / slug, either handle), or ② replies to me (the parent comment's author is me). Comments I wrote do not count.
 *
 * Returns the createdAt (ISO) of the latest relevant comment; null if none. The caller (poll) takes the max of it and the historical `lastMentionAt` to maintain a
 * monotonic cursor; whether it is "unread" is decided at read time by comparing against the read watermark `lastReadAt` (see pr-state.computeUnread) — so the watermark is not the concern here.
 *
 * Only called when poll detects a PR content change (updatedAt jumps) — avoids pulling comments every round for every tracked PR, keeping cost proportional to activity.
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether the body @mentions any handle. Requires that the char before `@` is not a word char (excludes emails like `a@h`), and `@handle` is not followed by a word char / `.` / `-`
 * (excludes `@handle2` falsely matching `@handle`). Case-insensitive.
 */
function mentionsAnyHandle(body: string, handles: readonly string[]): boolean {
  for (const h of handles) {
    if (!h) continue;
    const re = new RegExp(`(?<![\\w])@${escapeRegExp(h)}(?![\\w.-])`, 'i');
    if (re.test(body)) return true;
  }
  return false;
}

/** A comment hit relevant to me: being replied to (the parent comment's author is me) takes priority over being @mentioned (reply is a stronger relevance). */
export type MentionKind = 'mention' | 'reply';

/**
 * A hit in the comment tree for a "@me / reply to me" comment by others: time + kind + author (system notification avatar / originator) + comment locator
 * (`commentRemoteId` and `anchor`: for notification click-through — a non-null inline comment anchor can jump to the diff line, a summary comment anchor is null).
 */
export interface MentionHit {
  at: string;
  kind: MentionKind;
  author: PlatformUser;
  commentRemoteId: string;
  anchor: PrCommentAnchor | null;
}

/**
 * All hits in the comment tree for "@me / reply to me" comments by others (time + kind), depth-first, in natural arrival order (unsorted).
 * Relevance: ① the parent comment's author is me (reply), or ② the body @mentions me (mention); comments I wrote do not count. When both hold, recorded as reply.
 *
 * - `me`: the current user (taken from the adapter's cached identity during poll). handle is name + slug (deduplicated, non-empty).
 *
 * The caller (poll) uses this to take the latest cursor, count unread against the read watermark (see pr-state.computeUnreadMentionCount),
 * and project system notification events by kind.
 */
export function collectMentionsToMe(
  comments: readonly PrComment[],
  me: PlatformUser,
): MentionHit[] {
  const handles = [me.name, me.slug].filter((x): x is string => !!x);
  const lowered = new Set(handles.map((h) => h.toLowerCase()));
  const isMe = (u: PlatformUser): boolean =>
    lowered.has(u.name.toLowerCase()) || (u.slug ? lowered.has(u.slug.toLowerCase()) : false);

  const hits: MentionHit[] = [];
  const walk = (list: readonly PrComment[], parentIsMe: boolean): void => {
    for (const c of list) {
      const authoredByMe = isMe(c.author);
      if (!authoredByMe) {
        const base = { at: c.createdAt, author: c.author, commentRemoteId: c.remoteId, anchor: c.anchor };
        if (parentIsMe) hits.push({ ...base, kind: 'reply' });
        else if (mentionsAnyHandle(c.body, handles)) hits.push({ ...base, kind: 'mention' });
      }
      if (c.replies?.length) walk(c.replies, authoredByMe);
    }
  };
  walk(comments, false);
  return hits;
}

/** A comment by **others** in the comment tree (regardless of @me / reply to me): time + author + locator. Used for new-comment notifications on "my authored" PRs. */
export interface CommentHit {
  at: string;
  author: PlatformUser;
  commentRemoteId: string;
  anchor: PrCommentAnchor | null;
}

/**
 * Hits for **all comments by others** in the comment tree (author is not the current user), depth-first, in natural arrival order (unsorted). Unlike
 * {@link collectMentionsToMe}: does not filter by @me / reply to me, collecting all comments by others — for the "received new comment" notification on "my authored" PRs
 * (comments by the author themselves do not count, so it will not false-alarm on one's own comments).
 */
export function collectCommentsFromOthers(
  comments: readonly PrComment[],
  me: PlatformUser,
): CommentHit[] {
  const handles = [me.name, me.slug].filter((x): x is string => !!x);
  const lowered = new Set(handles.map((h) => h.toLowerCase()));
  const isMe = (u: PlatformUser): boolean =>
    lowered.has(u.name.toLowerCase()) || (u.slug ? lowered.has(u.slug.toLowerCase()) : false);

  const hits: CommentHit[] = [];
  const walk = (list: readonly PrComment[]): void => {
    for (const c of list) {
      if (!isMe(c.author)) {
        hits.push({
          at: c.createdAt,
          author: c.author,
          commentRemoteId: c.remoteId,
          anchor: c.anchor,
        });
      }
      if (c.replies?.length) walk(c.replies);
    }
  };
  walk(comments);
  return hits;
}

/**
 * List of createdAt (ISO) for all "@me / reply to me" comments by others in the comment tree. Based on {@link collectMentionsToMe}.
 */
export function collectCommentsToMeAt(
  comments: readonly PrComment[],
  me: PlatformUser,
): string[] {
  return collectMentionsToMe(comments, me).map((h) => h.at);
}

/**
 * The createdAt (ISO) of the latest "@me / reply to me" comment by others in the comment tree; null if none. Based on {@link collectCommentsToMeAt}.
 */
export function latestCommentToMeAt(
  comments: readonly PrComment[],
  me: PlatformUser,
): string | null {
  let latest: string | null = null;
  for (const iso of collectCommentsToMeAt(comments, me)) {
    if (latest === null || Date.parse(iso) > Date.parse(latest)) latest = iso;
  }
  return latest;
}
