import type { PrComment, PrCommentAnchor, PrReaction, RepoRef } from '@meebox/shared';
import { BaseCommentService, type ConnectionContext } from '@meebox/platform-core';
import type { BitbucketClient } from '../client.js';
import { mapUser } from '../utils.js';
import type {
  BitbucketActivity,
  BitbucketComment,
  BitbucketCommentAnchor,
  BitbucketReactionProperty,
} from '../types.js';

/**
 * 规范化 emoji ↔ Bitbucket emoticon shortcut（写反应的 URL 段）。
 *
 * ⚠️ Bitbucket 的 emoticon shortcut 命名既不规范也未文档化（社区实测 `smile` / `laughing` /
 * `heart` 等，无完整清单）；下表为**最佳推定**，需对接真实实例校正（react 一次后 GET 评论看
 * `properties.reactions[].emoticon.shortcut`）。**读取展示**优先用 `emoticon.value`（Unicode），
 * 故下表主要服务**写入**（toggle）；写入用到错误 shortcut 时仅该 emoji 失败，不影响其余。
 */
const BB_REACTIONS: ReadonlyArray<readonly [string, string]> = [
  ['👍', 'thumbsup'],
  ['👎', 'thumbsdown'],
  ['😄', 'smile'],
  ['🎉', 'tada'],
  ['😕', 'confused'],
  ['❤️', 'heart'],
  ['🚀', 'rocket'],
  ['👀', 'eyes'],
];
const BB_SHORTCUT_BY_EMOJI = new Map(BB_REACTIONS.map(([emoji, sc]) => [emoji, sc]));
const BB_EMOJI_BY_SHORTCUT = new Map(BB_REACTIONS.map(([emoji, sc]) => [sc, emoji]));

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

  /**
   * 切换当前用户对评论的 emoji 反应（comment-likes 插件）：add=PUT、remove=DELETE 同一 reactions 端点。
   * 端点幂等（重复 PUT / 不存在时 DELETE 均 200），故无需先查状态。
   */
  override async toggleReaction(
    repo: RepoRef,
    prId: string,
    commentId: string,
    _kind: 'summary' | 'inline',
    emoji: string,
    add: boolean,
  ): Promise<void> {
    const shortcut = BB_SHORTCUT_BY_EMOJI.get(emoji);
    if (!shortcut) throw new Error(`Unsupported reaction emoji: ${emoji}`);
    const url = `/rest/comment-likes/latest/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/comments/${commentId}/reactions/${shortcut}`;
    if (add) await this.client.put(url, {});
    else await this.client.del(url);
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
      reactions: this.mapReactions(c.properties?.reactions),
      version: c.version,
    };
  }

  /**
   * Bitbucket `properties.reactions` → 中性 PrReaction[]（容错：形状未文档化）。
   *
   * 展示 emoji 优先取 `emoticon.value`（Unicode），否则按 shortcut 查映射；都缺则跳过该项。
   * `mine` 按 `users[]` 是否含当前用户（slug / name 任一匹配）判定；count 取字段值或 users 长度兜底。
   */
  private mapReactions(reactions: BitbucketReactionProperty[] | undefined): PrReaction[] {
    if (!reactions || reactions.length === 0) return [];
    const me = this.ctx.getCurrentUser();
    const out: PrReaction[] = [];
    for (const r of reactions) {
      const value = r.emoticon?.value;
      const emoji =
        value && !/^:.*:$/.test(value)
          ? value
          : BB_EMOJI_BY_SHORTCUT.get(r.emoticon?.shortcut ?? '');
      if (!emoji) continue;
      const users = r.users ?? [];
      const mine =
        me != null && users.some((u) => u.slug === me.slug || u.name === me.name);
      out.push({ emoji, count: r.count ?? users.length, mine });
    }
    return out;
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
