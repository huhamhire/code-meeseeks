import type { PrComment, PrCommentAnchor, RepoRef } from '@meebox/shared';
import { BaseCommentService, type ConnectionContext } from '@meebox/platform-core';
import type { BitbucketClient } from '../client.js';
import { mapUser } from '../utils.js';
import type { BitbucketActivity, BitbucketComment, BitbucketCommentAnchor } from '../types.js';

/** Bitbucket 评论领域：经 /activities 流归一评论树，发布 / 回复 / 删改走 comments 端点（带乐观锁）。 */
export class BitbucketCommentService extends BaseCommentService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: BitbucketClient,
  ) {
    super(ctx);
  }

  /**
   * 经 /activities 流取全部评论：过滤 COMMENTED + ADDED 的顶层评论（跳过 DELETED/UPDATED 派生事件与
   * 带 parent 的 reply），按 id 去重，reply 跟随父评论的 .comments 一并归一。
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
   * 发表 summary 评论（仅 text，不带 anchor / parent）。
   */
  async publishSummaryComment(repo: RepoRef, prId: string, body: string): Promise<PrComment> {
    const created = await this.client.post<BitbucketComment>(
      `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/comments`,
      { text: body },
    );
    return this.mapBitbucketComment(created);
  }

  /**
   * 发表 inline 评论：把中性锚点翻成 Bitbucket anchor 提交。
   *
   * anchor 的 line + lineType + fileType 三元组须与该行在 diff 里的真实角色一致，否则 Bitbucket 回
   * 400；diffType=EFFECTIVE 让评论锚到「当前生效 diff」，PR 后续 push 仍跟随行走。
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
   * 回复评论：POST comments，body 带 parent.id；不带 anchor（reply 继承父评论锚点）。
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
   * 编辑评论 body：PUT comments/{cid}，payload {text, version}（version 乐观锁，不一致回 409）。
   *
   * 正常返回更新后的评论（version+1）；上游异常回 204 时抛错（无法确认更新）。
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
   * 删除评论：DELETE comments/{cid}?version={v}（version 乐观锁必填，不一致 / 有 reply / 非作者回 409/403）。
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

  // ---- 映射（领域私有）----

  /**
   * Bitbucket 评论 → 中性 PrComment（递归归一 reply）。
   *
   * 透传 Bitbucket 乐观锁 version（删改时调用方须带回，否则 409）；anchor 为空则为 summary 评论。
   */
  private mapBitbucketComment(c: BitbucketComment, anchor?: BitbucketCommentAnchor): PrComment {
    return {
      remoteId: String(c.id),
      author: mapUser(c.author),
      body: c.text,
      createdAt: new Date(c.createdDate).toISOString(),
      updatedAt: new Date(c.updatedDate).toISOString(),
      anchor: anchor ? this.mapBitbucketAnchor(anchor) : null,
      replies: (c.comments ?? []).map((r) => this.mapBitbucketComment(r)),
      version: c.version,
    };
  }

  /**
   * Bitbucket 评论 anchor → 中性锚点。
   *
   * 无行号 = 文件级 / 孤儿 anchor，无法锚到具体行 → 返回 null（退化为 summary）；lineType 偶有缺省时
   * 兜底 'context'（最保守值，与发布 anchor 的兜底一致）。
   */
  private mapBitbucketAnchor(a: BitbucketCommentAnchor): PrCommentAnchor | null {
    if (a.line == null) return null;
    return {
      path: a.path,
      line: a.line,
      side: a.fileType === 'FROM' ? 'old' : 'new',
      lineType: (a.lineType?.toLowerCase() ?? 'context') as PrCommentAnchor['lineType'],
    };
  }

  /**
   * 中性锚点 → Bitbucket REST anchor 字段（发布 inline 评论用，mapBitbucketAnchor 的反方向）。
   *
   * diffType 显式给 'EFFECTIVE'，让评论锚到「当前生效 diff」而非某次具体 commit，PR 后续 push 仍跟随。
   */
  private toBBAnchor(a: PrCommentAnchor): BitbucketCommentAnchor {
    return {
      diffType: 'EFFECTIVE',
      path: a.path,
      line: a.line,
      lineType: a.lineType.toUpperCase() as BitbucketCommentAnchor['lineType'],
      fileType: a.side === 'old' ? 'FROM' : 'TO',
    };
  }
}
