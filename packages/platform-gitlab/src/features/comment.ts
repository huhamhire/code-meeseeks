import {
  emojiToReactionCode,
  reactionCodeToEmoji,
  type PrComment,
  type PrCommentAnchor,
  type PrReaction,
  type RepoRef,
} from '@meebox/shared';
import { BaseCommentService, collect, type ConnectionContext } from '@meebox/platform-core';
import { GitLabClientError, type GitLabClient } from '../client.js';
import { mapUser, projectId } from '../utils.js';
import type { GlAwardEmoji, GlDiscussion, GlMr, GlNote } from '../types.js';

/** GitLab comment domain: discussions + notes normalized into a unified comment tree (first note is top-level, the rest are replies). */
export class GitLabCommentService extends BaseCommentService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: GitLabClient,
  ) {
    super(ctx);
  }

  /**
   * Fetch MR discussions and normalize into a unified comment tree: each discussion's first note is top-level, the rest are replies.
   *
   * Filters out system notes (automatic events like status changes / assignments); discussions that are entirely system notes are skipped.
   */
  async listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]> {
    const me = this.ctx.getCurrentUser()?.name;
    const base = `/projects/${projectId(repo)}/merge_requests/${prId}`;
    // First collect all non-system notes flat (keeping discussion ownership), then fetch each note's award emoji in parallel.
    const discussions: Array<{ id: string; notes: GlNote[] }> = [];
    for await (const d of this.client.paginate<GlDiscussion>(`${base}/discussions`)) {
      const notes = d.notes.filter((n) => !n.system);
      if (notes.length > 0) discussions.push({ id: d.id, notes });
    }
    // GitLab note responses don't embed award emoji → query each note separately (in parallel). Volume is bounded by comment count and goes through the comment cache.
    const awardsByNote = await this.loadAwards(
      base,
      discussions.flatMap((d) => d.notes.map((n) => n.id)),
    );
    return discussions.map(({ id, notes }) => {
      const [head, ...rest] = notes;
      const top = this.mapNote(head!, id, me, awardsByNote.get(head!.id));
      top.replies = rest.map((n) => this.mapNote(n, id, me, awardsByNote.get(n.id)));
      return top;
    });
  }

  /**
   * Fetch award emoji for the given note list in parallel, returning `Map<noteId, GlAwardEmoji[]>`.
   * GitLab has no note-level award batch endpoint, so GET each one; the caller passes the note set in all at once to enable concurrency.
   */
  private async loadAwards(base: string, noteIds: number[]): Promise<Map<number, GlAwardEmoji[]>> {
    const out = new Map<number, GlAwardEmoji[]>();
    await Promise.all(
      noteIds.map(async (id) => {
        try {
          const list = await collect(
            this.client.paginate<GlAwardEmoji>(`${base}/notes/${id}/award_emoji`),
          );
          if (list.length > 0) out.set(id, list);
        } catch {
          // Reactions are an enhancement; a single note's award fetch failing (old version / permissions / missing endpoint) shouldn't drag down the entire comment list.
        }
      }),
    );
    return out;
  }

  /**
   * Toggle the current user's award emoji on a note. add: POST, if it already exists (GitLab returns 404 "already taken") skip as success;
   * remove: list and find one's own award id with that name, then DELETE, skipping if it doesn't exist.
   */
  override async toggleReaction(
    repo: RepoRef,
    prId: string,
    commentId: string,
    _kind: 'summary' | 'inline',
    emoji: string,
    add: boolean,
  ): Promise<void> {
    const name = emojiToReactionCode(emoji);
    if (!name) throw new Error(`Unsupported reaction emoji: ${emoji}`);
    const awardBase = `/projects/${projectId(repo)}/merge_requests/${prId}/notes/${commentId}/award_emoji`;
    if (add) {
      try {
        await this.client.post<GlAwardEmoji>(awardBase, { name });
      } catch (e) {
        // Already reacted → GitLab returns 404 "Name has already been taken", idempotently skip; other errors bubble up.
        if (!(e instanceof GitLabClientError && e.status === 404)) throw e;
      }
      return;
    }
    const me = this.ctx.getCurrentUser()?.name;
    const list = await collect(this.client.paginate<GlAwardEmoji>(awardBase));
    const mineOne = list.find((a) => a.name === name && a.user.username === me);
    if (!mineOne) return;
    await this.client.del(`${awardBase}/${mineOne.id}`);
  }

  /** GitLab award list + current username → neutral PrReaction[] (aggregated by first-appearance order; out-of-set emoji names are skipped from display). */
  private buildReactions(awards: GlAwardEmoji[] | undefined, me: string | undefined): PrReaction[] {
    if (!awards || awards.length === 0) return [];
    const byEmoji = new Map<string, PrReaction>();
    for (const a of awards) {
      const emoji = reactionCodeToEmoji(a.name);
      if (!emoji) continue; // award name outside the gemoji vocabulary → not displayed for now (best-effort)
      const r = byEmoji.get(emoji) ?? { emoji, count: 0, mine: false };
      r.count += 1;
      if (me != null && a.user.username === me) r.mine = true;
      byEmoji.set(emoji, r);
    }
    // Map preserves first-insertion order (≈ award appearance order), output directly.
    return [...byEmoji.values()];
  }

  /**
   * Post a summary comment: create a new discussion without a position (top-level note), then normalize and return.
   */
  async publishSummaryComment(repo: RepoRef, prId: string, body: string): Promise<PrComment> {
    // summary comment = new discussion without a position (top-level note)
    const created = await this.client.post<GlDiscussion>(
      `/projects/${projectId(repo)}/merge_requests/${prId}/discussions`,
      { body },
    );
    return this.mapNote(created.notes[0]!, created.id, this.ctx.getCurrentUser()?.name);
  }

  /**
   * Post an inline comment: create a discussion with a position.
   *
   * position needs the three base/start/head shas, so first fetch the MR to get diff_refs (throw if missing); anchor to new_line / old_line by side.
   */
  async publishInlineComment(
    repo: RepoRef,
    prId: string,
    anchor: PrCommentAnchor,
    body: string,
  ): Promise<PrComment> {
    // GitLab has no file-level diff-comment API (position_type is only text/image), so file-level anchors are
    // unsupported — the fileLevelComments capability is false, so the UI never offers it; guard defensively here.
    if (anchor.line == null) {
      throw new Error('GitLab does not support file-level diff comments');
    }
    const base = `/projects/${projectId(repo)}/merge_requests/${prId}`;
    // inline comment = discussion with a position; position needs the three base/start/head shas → first fetch the MR to get diff_refs.
    const mr = await this.client.get<GlMr>(base);
    const refs = mr.diff_refs;
    if (!refs) {
      throw new Error(
        'Cannot post inline comment: this MR has no diff_refs (the diff may not be generated yet)',
      );
    }
    const position: Record<string, unknown> = {
      base_sha: refs.base_sha,
      start_sha: refs.start_sha,
      head_sha: refs.head_sha,
      position_type: 'text',
      new_path: anchor.path,
      old_path: anchor.path,
    };
    // side 'new' (added/context) anchors to new_line; 'old' (removed) anchors to old_line.
    if (anchor.side === 'new') position.new_line = anchor.line;
    else position.old_line = anchor.line;
    const created = await this.client.post<GlDiscussion>(`${base}/discussions`, { body, position });
    return this.mapNote(created.notes[0]!, created.id, this.ctx.getCurrentUser()?.name);
  }

  /**
   * Append a note under the given discussion as a reply.
   *
   * parentCommentId is the discussion_id (threadId); the renderer already consistently passes threadId ?? remoteId.
   */
  async replyToComment(
    repo: RepoRef,
    prId: string,
    parentCommentId: string,
    body: string,
  ): Promise<PrComment> {
    // parentCommentId = discussion_id (threadId); the renderer now passes threadId ?? remoteId.
    const note = await this.client.post<GlNote>(
      `/projects/${projectId(repo)}/merge_requests/${prId}/discussions/${parentCommentId}/notes`,
      { body },
    );
    return this.mapNote(note, parentCommentId, this.ctx.getCurrentUser()?.name);
  }

  /**
   * Edit a comment body: overwrite the note within the discussion via /notes/:id.
   *
   * GitLab has no optimistic lock, version is ignored; the edit response carries no discussion id, so threadId falls back to the note id.
   */
  async editComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    _version: number,
    body: string,
  ): Promise<PrComment> {
    // GitLab has no comment optimistic lock (version ignored); /notes/:id overwrites the note within the discussion.
    const note = await this.client.put<GlNote>(
      `/projects/${projectId(repo)}/merge_requests/${prId}/notes/${commentId}`,
      { body },
    );
    if (!note) throw new Error('Failed to edit comment: empty response from remote');
    // The edit response carries no discussion id, so threadId falls back to the note id (the UI force-refreshes the comment tree after edit/delete).
    return this.mapNote(note, String(note.id), this.ctx.getCurrentUser()?.name);
  }

  /**
   * Delete a comment note. GitLab has no optimistic lock, version is ignored.
   */
  async deleteComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    _version: number,
  ): Promise<void> {
    await this.client.del(`/projects/${projectId(repo)}/merge_requests/${prId}/notes/${commentId}`);
  }

  // ---- Mapping (domain-private) ----

  /**
   * Normalize a GitLab note into a PrComment.
   *
   * With a text position, derive the anchor (determine side and line type from new_line / old_line) and mark as inline, otherwise mark as summary;
   * mark canEdit / canDelete by whether the author is the current user; GitLab has no optimistic lock, so version is set to 0 as a sentinel.
   */
  private mapNote(
    n: GlNote,
    discussionId: string,
    me: string | undefined,
    awards?: GlAwardEmoji[],
  ): PrComment {
    const pos = n.position;
    const anchor: PrCommentAnchor | null =
      pos && pos.position_type === 'text' && (pos.new_line != null || pos.old_line != null)
        ? {
            path: pos.new_path ?? pos.old_path ?? '',
            line: pos.new_line ?? pos.old_line ?? 0,
            side: pos.new_line != null ? 'new' : 'old',
            // new_line + old_line both present = context; only new = added; only old = removed.
            lineType:
              pos.new_line != null ? (pos.old_line != null ? 'context' : 'added') : 'removed',
          }
        : null;
    const isMine = me != null && n.author.username === me;
    return {
      remoteId: String(n.id),
      author: mapUser(n.author),
      body: n.body,
      createdAt: n.created_at,
      updatedAt: n.updated_at,
      anchor,
      replies: [],
      kind: anchor ? 'inline' : 'summary',
      threadId: discussionId,
      nativeId: String(n.id),
      reactions: this.buildReactions(awards, me),
      canDelete: isMine,
      canEdit: isMine,
      // GitLab has no optimistic lock: set to 0 as a "no concurrency token needed" sentinel, so the canEdit/canDelete
      // decision and the edit/delete IPC's version: number contract pass uniformly (editComment/deleteComment ignore version).
      version: 0,
    };
  }
}
