import type { PrComment, PrCommentAnchor, RepoRef } from '@meebox/shared';
import { BaseCommentService, type ConnectionContext } from '@meebox/platform-core';
import type { GitLabClient } from '../client.js';
import { mapUser, projectId } from '../utils.js';
import type { GlDiscussion, GlMr, GlNote } from '../types.js';

/** GitLab 评论领域：discussions + notes 归一为统一评论树（首 note 顶层、其余 reply）。 */
export class GitLabCommentService extends BaseCommentService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: GitLabClient,
  ) {
    super(ctx);
  }

  async listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]> {
    const me = this.ctx.getCurrentUser()?.name;
    const out: PrComment[] = [];
    for await (const d of this.client.paginate<GlDiscussion>(
      `/projects/${projectId(repo)}/merge_requests/${prId}/discussions`,
    )) {
      // 过滤 system note（状态变更 / 指派等自动事件）。
      const notes = d.notes.filter((n) => !n.system);
      if (notes.length === 0) continue;
      const [head, ...rest] = notes;
      const top = this.mapNote(head!, d.id, me);
      top.replies = rest.map((n) => this.mapNote(n, d.id, me));
      out.push(top);
    }
    return out;
  }

  async publishSummaryComment(repo: RepoRef, prId: string, body: string): Promise<PrComment> {
    // summary 评论 = 不带 position 的新 discussion（顶层 note）
    const created = await this.client.post<GlDiscussion>(
      `/projects/${projectId(repo)}/merge_requests/${prId}/discussions`,
      { body },
    );
    return this.mapNote(created.notes[0]!, created.id, this.ctx.getCurrentUser()?.name);
  }

  async publishInlineComment(
    repo: RepoRef,
    prId: string,
    anchor: PrCommentAnchor,
    body: string,
  ): Promise<PrComment> {
    const base = `/projects/${projectId(repo)}/merge_requests/${prId}`;
    // 行内评论 = 带 position 的 discussion；position 需 base/start/head 三 sha → 先拉 MR 取 diff_refs。
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
    // side 'new'（added/context）锚到 new_line；'old'（removed）锚到 old_line。
    if (anchor.side === 'new') position.new_line = anchor.line;
    else position.old_line = anchor.line;
    const created = await this.client.post<GlDiscussion>(`${base}/discussions`, { body, position });
    return this.mapNote(created.notes[0]!, created.id, this.ctx.getCurrentUser()?.name);
  }

  async replyToComment(
    repo: RepoRef,
    prId: string,
    parentCommentId: string,
    body: string,
  ): Promise<PrComment> {
    // parentCommentId = discussion_id（threadId）；renderer 已改为传 threadId ?? remoteId。
    const note = await this.client.post<GlNote>(
      `/projects/${projectId(repo)}/merge_requests/${prId}/discussions/${parentCommentId}/notes`,
      { body },
    );
    return this.mapNote(note, parentCommentId, this.ctx.getCurrentUser()?.name);
  }

  async editComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    _version: number,
    body: string,
  ): Promise<PrComment> {
    // GitLab 无评论乐观锁（version 忽略）；/notes/:id 覆盖 discussion 内 note。
    const note = await this.client.put<GlNote>(
      `/projects/${projectId(repo)}/merge_requests/${prId}/notes/${commentId}`,
      { body },
    );
    if (!note) throw new Error('Failed to edit comment: empty response from remote');
    // 编辑响应不带 discussion id，threadId 用 note id 兜底（UI 删改后会 force-refresh 评论树）。
    return this.mapNote(note, String(note.id), this.ctx.getCurrentUser()?.name);
  }

  async deleteComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    _version: number,
  ): Promise<void> {
    await this.client.del(`/projects/${projectId(repo)}/merge_requests/${prId}/notes/${commentId}`);
  }

  // ---- 映射（领域私有）----

  private mapNote(n: GlNote, discussionId: string, me: string | undefined): PrComment {
    const pos = n.position;
    const anchor: PrCommentAnchor | null =
      pos && pos.position_type === 'text' && (pos.new_line != null || pos.old_line != null)
        ? {
            path: pos.new_path ?? pos.old_path ?? '',
            line: pos.new_line ?? pos.old_line ?? 0,
            side: pos.new_line != null ? 'new' : 'old',
            // new_line + old_line 同在 = context；仅 new = added；仅 old = removed。
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
      canDelete: isMine,
      canEdit: isMine,
      // GitLab 无乐观锁：置 0 作「无需并发令牌」哨兵，让 canEdit/canDelete 判定与编辑/删除 IPC
      // 的 version: number 契约统一通过（editComment/deleteComment 忽略 version）。
      version: 0,
    };
  }
}
