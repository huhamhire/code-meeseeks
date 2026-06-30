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

/** GitLab 评论领域：discussions + notes 归一为统一评论树（首 note 顶层、其余 reply）。 */
export class GitLabCommentService extends BaseCommentService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: GitLabClient,
  ) {
    super(ctx);
  }

  /**
   * 拉取 MR discussions 并归一为统一评论树：每个 discussion 首 note 为顶层、其余为 reply。
   *
   * 过滤 system note（状态变更 / 指派等自动事件）；全为 system note 的 discussion 跳过。
   */
  async listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]> {
    const me = this.ctx.getCurrentUser()?.name;
    const base = `/projects/${projectId(repo)}/merge_requests/${prId}`;
    // 先把所有非 system note 平铺收齐（保留 discussion 归属），再并行拉每条 note 的 award emoji。
    const discussions: Array<{ id: string; notes: GlNote[] }> = [];
    for await (const d of this.client.paginate<GlDiscussion>(`${base}/discussions`)) {
      const notes = d.notes.filter((n) => !n.system);
      if (notes.length > 0) discussions.push({ id: d.id, notes });
    }
    // GitLab note 响应不内嵌 award emoji → 每条 note 单独查（并行）。量受评论数约束、且走评论缓存。
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
   * 并行拉取给定 note 列表的 award emoji，返回 `Map<noteId, GlAwardEmoji[]>`。
   * GitLab 无 note 级 award 批量端点，故逐条 GET；调用方已把 note 集合一次性传入以便并发。
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
          // 反应是增强项，单条 note 的 award 拉取失败（旧版本 / 权限 / 端点缺失）不应拖垮整个评论列表。
        }
      }),
    );
    return out;
  }

  /**
   * 切换当前用户对一条 note 的 award emoji。add：POST，已存在（GitLab 回 404 "已被占用"）按成功跳过；
   * remove：列出找到自己该 name 的 award id 再 DELETE，不存在则跳过。
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
        // 已反应过 → GitLab 回 404 "Name has already been taken"，幂等跳过；其余错误冒泡。
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

  /** GitLab award 列表 + 当前用户名 → 中性 PrReaction[]（按首次出现序聚合；集外 emoji 名跳过显示）。 */
  private buildReactions(awards: GlAwardEmoji[] | undefined, me: string | undefined): PrReaction[] {
    if (!awards || awards.length === 0) return [];
    const byEmoji = new Map<string, PrReaction>();
    for (const a of awards) {
      const emoji = reactionCodeToEmoji(a.name);
      if (!emoji) continue; // gemoji 词表外的 award 名 → 暂不显示（best-effort）
      const r = byEmoji.get(emoji) ?? { emoji, count: 0, mine: false };
      r.count += 1;
      if (me != null && a.user.username === me) r.mine = true;
      byEmoji.set(emoji, r);
    }
    // Map 保留首次插入序（≈ award 出现序），直接输出。
    return [...byEmoji.values()];
  }

  /**
   * 发表 summary 评论：创建一个不带 position 的新 discussion（顶层 note）后归一返回。
   */
  async publishSummaryComment(repo: RepoRef, prId: string, body: string): Promise<PrComment> {
    // summary 评论 = 不带 position 的新 discussion（顶层 note）
    const created = await this.client.post<GlDiscussion>(
      `/projects/${projectId(repo)}/merge_requests/${prId}/discussions`,
      { body },
    );
    return this.mapNote(created.notes[0]!, created.id, this.ctx.getCurrentUser()?.name);
  }

  /**
   * 发表 inline 评论：创建带 position 的 discussion。
   *
   * position 需 base/start/head 三 sha，先拉 MR 取 diff_refs（缺失则抛错）；按 side 锚到 new_line / old_line。
   */
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

  /**
   * 在指定 discussion 下追加一条 note 作为回复。
   *
   * parentCommentId 即 discussion_id（threadId），renderer 已统一传 threadId ?? remoteId。
   */
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

  /**
   * 编辑评论 body：经 /notes/:id 覆盖 discussion 内 note。
   *
   * GitLab 无乐观锁，version 忽略；编辑响应不带 discussion id，threadId 用 note id 兜底。
   */
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

  /**
   * 删除一条评论 note。GitLab 无乐观锁，version 忽略。
   */
  async deleteComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    _version: number,
  ): Promise<void> {
    await this.client.del(`/projects/${projectId(repo)}/merge_requests/${prId}/notes/${commentId}`);
  }

  // ---- 映射（领域私有）----

  /**
   * 把 GitLab note 归一为 PrComment。
   *
   * 有 text position 时推导锚点（按 new_line / old_line 判侧与行类型）、记为 inline，否则记为 summary；
   * 按作者是否为当前用户标记 canEdit / canDelete；GitLab 无乐观锁，version 置 0 作哨兵。
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
      reactions: this.buildReactions(awards, me),
      canDelete: isMine,
      canEdit: isMine,
      // GitLab 无乐观锁：置 0 作「无需并发令牌」哨兵，让 canEdit/canDelete 判定与编辑/删除 IPC
      // 的 version: number 契约统一通过（editComment/deleteComment 忽略 version）。
      version: 0,
    };
  }
}
