import {
  emojiToReactionCode,
  reactionCodeToEmoji,
  type PrComment,
  type PrCommentAnchor,
  type PrReaction,
  type RepoRef,
} from '@meebox/shared';
import { BaseCommentService, type ConnectionContext } from '@meebox/platform-core';
import type { BitbucketClient } from '../client.js';
import { mapUser } from '../utils.js';
import type {
  BitbucketActivity,
  BitbucketComment,
  BitbucketCommentAnchor,
  BitbucketReactionProperty,
} from '../types.js';

// emoji ↔ Bitbucket emoticon shortcut (= gemoji shortcode) converted via the shared gemoji table: writing
// (toggle) uses emojiToReactionCode; for read/display, prefer decoding code points from the twemoji url
// (emojiFromTwemojiUrl), falling back to shortcut via reactionCodeToEmoji. Confirmed in practice that a
// shortcode like `eyes` works (see docs/arch/01-platform/04-comment-interactions).

/**
 * Decode the emoji character from a Bitbucket emoticon's twemoji resource URL: the filename is Unicode
 * code points (hyphen-separated for multiple code points, e.g. `1f440.svg` → 👀, `2764-fe0f.svg` → ❤️).
 * Returns undefined when it cannot be parsed (caller falls back to the shortcut mapping).
 */
function emojiFromTwemojiUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const file = url.split('/').pop()?.replace(/\.svg$/i, '');
  if (!file || !/^[0-9a-f]+(-[0-9a-f]+)*$/i.test(file)) return undefined;
  try {
    return String.fromCodePoint(...file.split('-').map((h) => Number.parseInt(h, 16)));
  } catch {
    return undefined;
  }
}

/** Bitbucket comment domain: normalize the comment tree via the /activities stream; publish / reply / edit-delete go through the comments endpoint (with optimistic lock). */
export class BitbucketCommentService extends BaseCommentService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: BitbucketClient,
  ) {
    super(ctx);
  }

  /**
   * Get all comments via the /activities stream: filter top-level comments that are COMMENTED + ADDED
   * (skip DELETED/UPDATED derived events and replies with a parent), dedupe by id, and normalize replies
   * along with their parent comment's .comments.
   */
  async listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]> {
    const seen = new Set<string>();
    const out: PrComment[] = [];
    for await (const activity of this.client.paginate<BitbucketActivity>(
      `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/activities`,
    )) {
      if (activity.action !== 'COMMENTED') continue;
      if (activity.commentAction !== 'ADDED') continue;
      const c = activity.comment;
      if (!c) continue;
      if (c.parent) continue;
      const id = String(c.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(this.mapBitbucketComment(c, activity.commentAnchor));
    }
    return out;
  }

  /**
   * Post a summary comment (text only, no anchor / parent).
   */
  async publishSummaryComment(repo: RepoRef, prId: string, body: string): Promise<PrComment> {
    const created = await this.client.post<BitbucketComment>(
      `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/comments`,
      { text: body },
    );
    return this.mapBitbucketComment(created);
  }

  /**
   * Post an inline comment: translate the neutral anchor into a Bitbucket anchor for submission.
   *
   * The anchor's line + lineType + fileType triple must match the line's real role in the diff, otherwise
   * Bitbucket returns 400; diffType=EFFECTIVE anchors the comment to the "currently effective diff", and it
   * still follows the line across subsequent PR pushes.
   */
  async publishInlineComment(
    repo: RepoRef,
    prId: string,
    anchor: PrCommentAnchor,
    body: string,
  ): Promise<PrComment> {
    const created = await this.client.post<BitbucketComment>(
      `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/comments`,
      { text: body, anchor: this.toBBAnchor(anchor) },
    );
    return this.mapBitbucketComment(created);
  }

  /**
   * Reply to a comment: POST comments with parent.id in the body; no anchor (a reply inherits the parent comment's anchor).
   */
  async replyToComment(
    repo: RepoRef,
    prId: string,
    parentCommentId: string,
    body: string,
  ): Promise<PrComment> {
    const created = await this.client.post<BitbucketComment>(
      `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/comments`,
      { text: body, parent: { id: Number(parentCommentId) } },
    );
    return this.mapBitbucketComment(created);
  }

  /**
   * Edit a comment body: PUT comments/{cid}, payload {text, version} (version is an optimistic lock; a mismatch returns 409).
   *
   * Normally returns the updated comment (version+1); throws when upstream anomalously returns 204 (cannot confirm the update).
   */
  async editComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    version: number,
    body: string,
  ): Promise<PrComment> {
    const updated = await this.client.put<BitbucketComment>(
      `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/comments/${commentId}`,
      { text: body, version },
    );
    if (!updated) {
      throw new Error(
        'editComment: Bitbucket returned an empty response; cannot confirm the update',
      );
    }
    return this.mapBitbucketComment(updated);
  }

  /**
   * Delete a comment: DELETE comments/{cid}?version={v} (version optimistic lock is required; mismatch / has replies / not the author returns 409/403).
   */
  async deleteComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    version: number,
  ): Promise<void> {
    await this.client.del(
      `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/comments/${commentId}?version=${String(version)}`,
    );
  }

  /**
   * Toggle the current user's emoji reaction on a comment (comment-likes plugin): add=PUT, remove=DELETE on the same reactions endpoint.
   * The endpoint is idempotent (repeated PUT / DELETE when nonexistent both return 200), so there is no need to query state first.
   */
  override async toggleReaction(
    repo: RepoRef,
    prId: string,
    commentId: string,
    _kind: 'summary' | 'inline',
    emoji: string,
    add: boolean,
  ): Promise<void> {
    const shortcut = emojiToReactionCode(emoji);
    if (!shortcut) throw new Error(`Unsupported reaction emoji: ${emoji}`);
    const url = `/rest/comment-likes/latest/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/comments/${commentId}/reactions/${shortcut}`;
    if (add) await this.client.put(url, {});
    else await this.client.del(url);
  }

  // ---- mapping (domain-private) ----

  /**
   * Bitbucket comment → neutral PrComment (recursively normalize replies).
   *
   * Passes through the Bitbucket optimistic-lock version (the caller must carry it back on edit/delete, otherwise 409); an empty anchor means a summary comment.
   */
  private mapBitbucketComment(c: BitbucketComment, anchor?: BitbucketCommentAnchor): PrComment {
    const mappedAnchor = anchor ? this.mapBitbucketAnchor(anchor) : null;
    return {
      remoteId: String(c.id),
      author: mapUser(c.author),
      body: c.text,
      createdAt: new Date(c.createdDate).toISOString(),
      updatedAt: new Date(c.updatedDate).toISOString(),
      anchor: mappedAnchor,
      kind: mappedAnchor == null ? 'summary' : mappedAnchor.line == null ? 'file' : 'inline',
      replies: (c.comments ?? []).map((r) => this.mapBitbucketComment(r)),
      reactions: this.mapReactions(c.properties?.reactions),
      version: c.version,
    };
  }

  /**
   * Bitbucket `properties.reactions` → neutral PrReaction[] (shape verified against a real instance).
   *
   * Display emoji is preferably decoded from the code points of `emoticon.url`'s twemoji filename (e.g.
   * `1f440.svg` → 👀, valid for any emoji), falling back to the shortcut name mapping; skip if neither works.
   * `mine` is based on whether `users[]` includes the current user (matching either slug or name); the count
   * is taken from `users.length` (Bitbucket does not return a count field).
   */
  private mapReactions(reactions: BitbucketReactionProperty[] | undefined): PrReaction[] {
    if (!reactions || reactions.length === 0) return [];
    const me = this.ctx.getCurrentUser();
    const out: PrReaction[] = [];
    for (const r of reactions) {
      const emoji =
        emojiFromTwemojiUrl(r.emoticon?.url) ?? reactionCodeToEmoji(r.emoticon?.shortcut ?? '');
      if (!emoji) continue;
      const users = r.users ?? [];
      const mine = me != null && users.some((u) => u.slug === me.slug || u.name === me.name);
      out.push({ emoji, count: users.length, mine });
    }
    return out;
  }

  /**
   * Bitbucket comment anchor → neutral anchor.
   *
   * No line number = a file-level comment (attached to the whole file) or an orphaned anchor (the anchored line no
   * longer exists) → keep it as a **file-level** anchor (path + side, no line) so the UI can still associate it with its
   * file, rather than degrading to a summary. When lineType is occasionally absent on a line anchor, fall back to
   * 'context' (the most conservative value, consistent with the publish-anchor fallback).
   */
  private mapBitbucketAnchor(a: BitbucketCommentAnchor): PrCommentAnchor {
    const side: PrCommentAnchor['side'] = a.fileType === 'FROM' ? 'old' : 'new';
    if (a.line == null) return { path: a.path, side };
    return {
      path: a.path,
      line: a.line,
      side,
      lineType: (a.lineType?.toLowerCase() ?? 'context') as NonNullable<PrCommentAnchor['lineType']>,
    };
  }

  /**
   * Neutral anchor → Bitbucket REST anchor fields (for publishing comments, the reverse of mapBitbucketAnchor).
   *
   * A file-level anchor (no line) sends only path + fileType (Bitbucket attaches the comment to the file). diffType is
   * explicitly set to 'EFFECTIVE', anchoring the comment to the "currently effective diff" rather than a specific
   * commit, so it still follows across subsequent PR pushes.
   */
  private toBBAnchor(a: PrCommentAnchor): BitbucketCommentAnchor {
    const fileType: BitbucketCommentAnchor['fileType'] = a.side === 'old' ? 'FROM' : 'TO';
    if (a.line == null) {
      return { diffType: 'EFFECTIVE', path: a.path, fileType };
    }
    return {
      diffType: 'EFFECTIVE',
      path: a.path,
      line: a.line,
      lineType: (a.lineType?.toUpperCase() ?? 'CONTEXT') as BitbucketCommentAnchor['lineType'],
      fileType,
    };
  }
}
