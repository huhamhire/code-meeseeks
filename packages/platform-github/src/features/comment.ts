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

/** GitHub 反应 content ↔ 规范化 emoji 字符（固定 8 种，与 REACTION_PICKER 同序）。 */
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

/** GitHub 评论领域：issue（summary）+ review（inline）两套端点归一为统一评论树。 */
export class GitHubCommentService extends BaseCommentService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: GitHubClient,
  ) {
    super(ctx);
  }

  /**
   * 并发拉取 issue 评论与 review 评论并归一为统一评论树。
   *
   * issue 评论作为无线程的 summary；review 评论按 in_reply_to_id 还原为顶层 + 嵌套 replies。
   */
  async listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]> {
    const prefix = `/repos/${repo.projectKey}/${repo.repoSlug}`;
    const [issueComments, reviewComments] = await Promise.all([
      collect(this.client.paginate<GhIssueComment>(`${prefix}/issues/${prId}/comments`)),
      collect(this.client.paginate<GhReviewComment>(`${prefix}/pulls/${prId}/comments`)),
    ]);

    // 反应聚合（counts）随评论响应即得；`mine` 需另查列表端点——仅对有反应的评论拉、并行，
    // 把当前用户已反应的 content 收进 Map（按 issue/review 前缀区分 id 空间）。
    const mineByKey = await this.loadMineReactions(prefix, issueComments, reviewComments);

    // issue 评论 = summary（无线程）
    const summary = issueComments.map((c) => this.mapIssueComment(c, mineByKey.get(`i:${c.id}`)));

    // review 评论 = inline，按 in_reply_to_id 还原成 顶层 + 嵌套 replies
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
   * 并行拉取「有反应」评论的反应列表，返回 `Map<'i:'|'r:'+id, Set<content>>`（当前用户已反应的 content）。
   * 只对 `reactions.total_count > 0` 的评论发请求——大多数评论无反应，故额外请求数受真实反应数约束。
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
          // 反应是增强项，单条评论的反应列表拉取失败不应拖垮整个评论列表（counts 仍按 rollup 展示）。
        }
      }),
    );
    return out;
  }

  /**
   * 切换当前用户对评论的 emoji 反应。kind=summary → issue 反应端点；inline → review 反应端点。
   * add：POST 幂等（已反应则原样返回）；remove：先列表找到自己该 content 的反应 id 再 DELETE，不存在则跳过。
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

  /** 反应聚合（counts）+ 当前用户已反应集合 → 中性 PrReaction[]（按固定 8 序、过滤 0 计数）。 */
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
   * 发表 summary 评论：经 issue 评论端点创建（无线程、无锚点）后归一返回。
   */
  async publishSummaryComment(repo: RepoRef, prId: string, body: string): Promise<PrComment> {
    // summary 评论 = issue 评论（无线程、无锚点）
    const created = await this.client.post<GhIssueComment>(
      `/repos/${repo.projectKey}/${repo.repoSlug}/issues/${prId}/comments`,
      { body },
    );
    return this.mapIssueComment(created);
  }

  /**
   * 发表 inline 评论：先拉 PR 取 head sha 作 commit_id，再按锚点（路径 / 行 / 侧）创建 review 评论。
   */
  async publishInlineComment(
    repo: RepoRef,
    prId: string,
    anchor: PrCommentAnchor,
    body: string,
  ): Promise<PrComment> {
    const prefix = `/repos/${repo.projectKey}/${repo.repoSlug}`;
    // 行内评论需 commit_id = head sha；按 Phase 0 决策，adapter 内部拉 PR 取 head sha
    const pull = await this.client.get<GhPull>(`${prefix}/pulls/${prId}`);
    const created = await this.client.post<GhReviewComment>(`${prefix}/pulls/${prId}/comments`, {
      body,
      commit_id: pull.head.sha,
      path: anchor.path,
      line: anchor.line,
      side: anchor.side === 'old' ? 'LEFT' : 'RIGHT',
    });
    return this.mapReviewComment(created);
  }

  /**
   * 回复评论：优先按 inline review-comment 的 replies 端点回复。
   *
   * 父评论实为 summary（issue 评论、无线程）时端点返回 404/422，退化为新建一条 issue 评论。
   */
  async replyToComment(
    repo: RepoRef,
    prId: string,
    parentCommentId: string,
    body: string,
  ): Promise<PrComment> {
    const prefix = `/repos/${repo.projectKey}/${repo.repoSlug}`;
    try {
      // 优先按 inline review-comment 回复
      const created = await this.client.post<GhReviewComment>(
        `${prefix}/pulls/${prId}/comments/${parentCommentId}/replies`,
        { body },
      );
      return this.mapReviewComment(created);
    } catch (e) {
      // 父评论是 summary（issue 评论，无线程）→ 退化为新建 issue 评论
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
   * 编辑评论 body：先按 review 评论端点尝试，404 时回退到 issue 评论端点。
   *
   * GitHub 无乐观锁，version 参数被忽略。
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
   * 删除评论：先按 review 评论端点尝试，404 时回退到 issue 评论端点。
   *
   * GitHub 无乐观锁，version 参数被忽略。
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

  // ---- 映射（领域私有）----

  /**
   * 把 GitHub issue 评论归一为 summary 类 PrComment；无锚点、无线程，version 置 0 作无锁哨兵。
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
      // GitHub 无乐观锁：置 0 作「无需并发令牌」哨兵，让 canEdit/canDelete 判定与编辑/删除 IPC
      // 的 version: number 契约统一通过（editComment/deleteComment 忽略 version）。
      version: 0,
    };
  }

  /**
   * 把 GitHub review 评论归一为 inline 类 PrComment。
   *
   * 锚点按 line / original_line 与 side 推导；GitHub 不直接给行类型，按 side 取保守默认（仅展示用）。
   */
  private mapReviewComment(c: GhReviewComment, mine?: Set<string>): PrComment {
    const line = c.line ?? c.original_line ?? null;
    const anchor: PrCommentAnchor | null =
      line != null
        ? {
            path: c.path,
            line,
            side: c.side === 'LEFT' ? 'old' : 'new',
            // GitHub 不直接给 added/removed/context；按 side 取保守默认（仅展示用）
            lineType: c.side === 'LEFT' ? 'removed' : 'added',
          }
        : null;
    return {
      remoteId: String(c.id),
      author: mapUser(c.user),
      body: c.body,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      anchor,
      replies: [],
      kind: 'inline',
      threadId: String(c.id),
      nativeId: String(c.id),
      reactions: this.buildReactions(c.reactions, mine),
      // 无乐观锁哨兵，同 mapIssueComment。
      version: 0,
    };
  }
}
