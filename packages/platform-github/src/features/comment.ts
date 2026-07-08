import type { PrComment, PrCommentAnchor, PrReaction, RepoRef } from '@meebox/shared';
import { BaseCommentService, collect, type ConnectionContext } from '@meebox/platform-core';
import { GitHubClientError, type GitHubClient } from '../client.js';
import { mapUser } from '../utils.js';
import type {
  GhIssueComment,
  GhPull,
  GhReaction,
  GhReactionRollup,
  GhReviewComment,
} from '../types.js';

/** GitHub reaction content ↔ normalized emoji character (fixed 8 kinds, same order as REACTION_PICKER). */
const GH_REACTIONS: ReadonlyArray<readonly [keyof Omit<GhReactionRollup, 'total_count'>, string]> = [
  ['+1', '👍'],
  ['-1', '👎'],
  ['laugh', '😄'],
  ['hooray', '🎉'],
  ['confused', '😕'],
  ['heart', '❤️'],
  ['rocket', '🚀'],
  ['eyes', '👀'],
];
const GH_CONTENT_BY_EMOJI = new Map(GH_REACTIONS.map(([content, emoji]) => [emoji, content]));

/** GitHub comment domain: issue (summary) + review (inline) two endpoint sets normalized into a unified comment tree. */
export class GitHubCommentService extends BaseCommentService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: GitHubClient,
  ) {
    super(ctx);
  }

  /**
   * Concurrently fetch issue comments and review comments and normalize into a unified comment tree.
   *
   * Issue comments serve as thread-less summaries; review comments are reconstructed by in_reply_to_id into top-level + nested replies.
   */
  async listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]> {
    const prefix = `/repos/${repo.projectKey}/${repo.repoSlug}`;
    const [issueComments, reviewComments] = await Promise.all([
      collect(this.client.paginate<GhIssueComment>(`${prefix}/issues/${prId}/comments`)),
      collect(this.client.paginate<GhReviewComment>(`${prefix}/pulls/${prId}/comments`)),
    ]);

    // Reaction aggregation (counts) comes with the comment response; `mine` needs a separate list endpoint — fetched only for comments with reactions, in parallel,
    // collecting the content the current user has reacted with into a Map (id space distinguished by issue/review prefix).
    const mineByKey = await this.loadMineReactions(prefix, issueComments, reviewComments);

    // issue comments = summary (thread-less)
    const summary = issueComments.map((c) => this.mapIssueComment(c, mineByKey.get(`i:${c.id}`)));

    // review comments = inline, reconstructed by in_reply_to_id into top-level + nested replies
    const repliesByParent = new Map<number, GhReviewComment[]>();
    const tops: GhReviewComment[] = [];
    for (const rc of reviewComments) {
      if (rc.in_reply_to_id != null) {
        const arr = repliesByParent.get(rc.in_reply_to_id) ?? [];
        arr.push(rc);
        repliesByParent.set(rc.in_reply_to_id, arr);
      } else {
        tops.push(rc);
      }
    }
    const inline = tops.map((rc) => {
      const pc = this.mapReviewComment(rc, mineByKey.get(`r:${rc.id}`));
      pc.replies = (repliesByParent.get(rc.id) ?? []).map((r) =>
        this.mapReviewComment(r, mineByKey.get(`r:${r.id}`)),
      );
      return pc;
    });

    return [...summary, ...inline];
  }

  /**
   * Fetch in parallel the reaction lists of comments "with reactions", returning `Map<'i:'|'r:'+id, Set<content>>` (content the current user has reacted with).
   * Only sends requests for comments with `reactions.total_count > 0` — most comments have no reactions, so the extra request count is bounded by the real reaction count.
   */
  private async loadMineReactions(
    prefix: string,
    issueComments: GhIssueComment[],
    reviewComments: GhReviewComment[],
  ): Promise<Map<string, Set<string>>> {
    const login = this.ctx.getCurrentUser()?.name;
    const out = new Map<string, Set<string>>();
    if (!login) return out;
    const targets: Array<{ key: string; url: string }> = [];
    for (const c of issueComments)
      if ((c.reactions?.total_count ?? 0) > 0)
        targets.push({ key: `i:${c.id}`, url: `${prefix}/issues/comments/${c.id}/reactions` });
    for (const c of reviewComments)
      if ((c.reactions?.total_count ?? 0) > 0)
        targets.push({ key: `r:${c.id}`, url: `${prefix}/pulls/comments/${c.id}/reactions` });
    await Promise.all(
      targets.map(async ({ key, url }) => {
        try {
          const list = await collect(this.client.paginate<GhReaction>(url));
          const mine = new Set<string>();
          for (const r of list) if (r.user?.login === login) mine.add(r.content);
          out.set(key, mine);
        } catch {
          // Reactions are an enhancement; a failed reaction-list fetch for a single comment should not drag down the entire comment list (counts are still shown from the rollup).
        }
      }),
    );
    return out;
  }

  /**
   * Toggle the current user's emoji reaction on a comment. kind=summary → issue reaction endpoint; inline → review reaction endpoint.
   * add: POST is idempotent (returns as-is if already reacted); remove: first find own reaction id for that content in the list, then DELETE, skip if not present.
   */
  override async toggleReaction(
    repo: RepoRef,
    _prId: string,
    commentId: string,
    kind: 'summary' | 'inline',
    emoji: string,
    add: boolean,
  ): Promise<void> {
    const content = GH_CONTENT_BY_EMOJI.get(emoji);
    if (!content) throw new Error(`Unsupported reaction emoji: ${emoji}`);
    const prefix = `/repos/${repo.projectKey}/${repo.repoSlug}`;
    const base =
      kind === 'summary'
        ? `${prefix}/issues/comments/${commentId}/reactions`
        : `${prefix}/pulls/comments/${commentId}/reactions`;
    if (add) {
      await this.client.post<GhReaction>(base, { content });
      return;
    }
    const login = this.ctx.getCurrentUser()?.name;
    const list = await collect(this.client.paginate<GhReaction>(base));
    const mineOne = list.find((r) => r.content === content && r.user?.login === login);
    if (!mineOne) return;
    await this.client.del(`${base}/${mineOne.id}`);
  }

  /** Reaction aggregation (counts) + the current user's reacted set → neutral PrReaction[] (in fixed 8 order, filtering out 0 counts). */
  private buildReactions(
    rollup: GhReactionRollup | undefined,
    mine: Set<string> | undefined,
  ): PrReaction[] {
    if (!rollup) return [];
    const out: PrReaction[] = [];
    for (const [content, emoji] of GH_REACTIONS) {
      const count = rollup[content] ?? 0;
      if (count > 0) out.push({ emoji, count, mine: mine?.has(content) ?? false });
    }
    return out;
  }

  /**
   * Publish a summary comment: created via the issue comment endpoint (thread-less, anchor-less) and returned normalized.
   */
  async publishSummaryComment(repo: RepoRef, prId: string, body: string): Promise<PrComment> {
    // summary comment = issue comment (thread-less, anchor-less)
    const created = await this.client.post<GhIssueComment>(
      `/repos/${repo.projectKey}/${repo.repoSlug}/issues/${prId}/comments`,
      { body },
    );
    return this.mapIssueComment(created);
  }

  /**
   * Publish a comment anchored to the diff: to a specific line (path / line / side) or, when the anchor has no line, to
   * the whole file via `subject_type: "file"` (a file-level comment). First fetches the PR to get head sha as commit_id.
   */
  async publishInlineComment(
    repo: RepoRef,
    prId: string,
    anchor: PrCommentAnchor,
    body: string,
  ): Promise<PrComment> {
    const prefix = `/repos/${repo.projectKey}/${repo.repoSlug}`;
    // Inline comments need commit_id = head sha; per the Phase 0 decision, the adapter internally fetches the PR to get head sha
    const pull = await this.client.get<GhPull>(`${prefix}/pulls/${prId}`);
    const req =
      anchor.line == null
        ? { body, commit_id: pull.head.sha, path: anchor.path, subject_type: 'file' as const }
        : {
            body,
            commit_id: pull.head.sha,
            path: anchor.path,
            line: anchor.line,
            side: anchor.side === 'old' ? 'LEFT' : 'RIGHT',
          };
    const created = await this.client.post<GhReviewComment>(
      `${prefix}/pulls/${prId}/comments`,
      req,
    );
    return this.mapReviewComment(created);
  }

  /**
   * Reply to a comment: prefer replying via the inline review-comment replies endpoint.
   *
   * When the parent comment is actually a summary (issue comment, thread-less) the endpoint returns 404/422, falling back to creating a new issue comment.
   */
  async replyToComment(
    repo: RepoRef,
    prId: string,
    parentCommentId: string,
    body: string,
  ): Promise<PrComment> {
    const prefix = `/repos/${repo.projectKey}/${repo.repoSlug}`;
    try {
      // Prefer replying via the inline review-comment
      const created = await this.client.post<GhReviewComment>(
        `${prefix}/pulls/${prId}/comments/${parentCommentId}/replies`,
        { body },
      );
      return this.mapReviewComment(created);
    } catch (e) {
      // Parent comment is a summary (issue comment, thread-less) → fall back to creating a new issue comment
      if (e instanceof GitHubClientError && (e.status === 404 || e.status === 422)) {
        const created = await this.client.post<GhIssueComment>(
          `${prefix}/issues/${prId}/comments`,
          { body },
        );
        return this.mapIssueComment(created);
      }
      throw e;
    }
  }

  /**
   * Edit a comment body: try the review comment endpoint first, fall back to the issue comment endpoint on 404.
   *
   * GitHub has no optimistic lock, the version parameter is ignored.
   */
  async editComment(
    repo: RepoRef,
    _prId: string,
    commentId: string,
    _version: number,
    body: string,
  ): Promise<PrComment> {
    const prefix = `/repos/${repo.projectKey}/${repo.repoSlug}`;
    try {
      const updated = await this.client.patch<GhReviewComment>(
        `${prefix}/pulls/comments/${commentId}`,
        { body },
      );
      return this.mapReviewComment(updated);
    } catch (e) {
      if (e instanceof GitHubClientError && e.status === 404) {
        const updated = await this.client.patch<GhIssueComment>(
          `${prefix}/issues/comments/${commentId}`,
          { body },
        );
        return this.mapIssueComment(updated);
      }
      throw e;
    }
  }

  /**
   * Delete a comment: try the review comment endpoint first, fall back to the issue comment endpoint on 404.
   *
   * GitHub has no optimistic lock, the version parameter is ignored.
   */
  async deleteComment(
    repo: RepoRef,
    _prId: string,
    commentId: string,
    _version: number,
  ): Promise<void> {
    const prefix = `/repos/${repo.projectKey}/${repo.repoSlug}`;
    try {
      await this.client.del(`${prefix}/pulls/comments/${commentId}`);
    } catch (e) {
      if (e instanceof GitHubClientError && e.status === 404) {
        await this.client.del(`${prefix}/issues/comments/${commentId}`);
        return;
      }
      throw e;
    }
  }

  // ---- Mapping (domain-private) ----

  /**
   * Normalize a GitHub issue comment into a summary-kind PrComment; anchor-less, thread-less, version set to 0 as a lock-less sentinel.
   */
  private mapIssueComment(c: GhIssueComment, mine?: Set<string>): PrComment {
    return {
      remoteId: String(c.id),
      author: mapUser(c.user),
      body: c.body,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      anchor: null,
      replies: [],
      kind: 'summary',
      nativeId: String(c.id),
      reactions: this.buildReactions(c.reactions, mine),
      // GitHub has no optimistic lock: set to 0 as a "no concurrency token needed" sentinel, so canEdit/canDelete decisions and the edit/delete IPC
      // version: number contract uniformly pass (editComment/deleteComment ignore version).
      version: 0,
    };
  }

  /**
   * Normalize a GitHub review comment into an inline-kind PrComment.
   *
   * The anchor is derived from line / original_line and side; GitHub does not directly give the line type, so a conservative default is taken by side (display-only).
   */
  private mapReviewComment(c: GhReviewComment, mine?: Set<string>): PrComment {
    const line = c.line ?? c.original_line ?? null;
    const side: PrCommentAnchor['side'] = c.side === 'LEFT' ? 'old' : 'new';
    const anchor: PrCommentAnchor | null =
      line != null
        ? {
            path: c.path,
            line,
            side,
            // GitHub does not directly give added/removed/context; take a conservative default by side (display-only)
            lineType: side === 'old' ? 'removed' : 'added',
          }
        : c.subject_type === 'file'
          ? // file-level review comment (no line): keep it anchored to the file, don't degrade to summary
            { path: c.path, side }
          : null;
    return {
      remoteId: String(c.id),
      author: mapUser(c.user),
      body: c.body,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      anchor,
      replies: [],
      kind: anchor != null && anchor.line == null ? 'file' : 'inline',
      threadId: String(c.id),
      nativeId: String(c.id),
      reactions: this.buildReactions(c.reactions, mine),
      // Lock-less sentinel, same as mapIssueComment.
      version: 0,
    };
  }
}
