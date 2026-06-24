import type { PrComment, PrCommentAnchor, RepoRef } from '@meebox/shared';
import { BaseCommentService, collect, type ConnectionContext } from '@meebox/platform-core';
import { GitHubClientError, type GitHubClient } from '../client.js';
import { mapUser } from '../mappers.js';
import type { GhIssueComment, GhPull, GhReviewComment } from '../types.js';

/** GitHub 评论领域：issue（summary）+ review（inline）两套端点归一为统一评论树。 */
export class GitHubCommentService extends BaseCommentService {
  constructor(
    ctx: ConnectionContext,
    private readonly client: GitHubClient,
  ) {
    super(ctx);
  }

  async listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]> {
    const prefix = `/repos/${repo.projectKey}/${repo.repoSlug}`;
    const [issueComments, reviewComments] = await Promise.all([
      collect(this.client.paginate<GhIssueComment>(`${prefix}/issues/${prId}/comments`)),
      collect(this.client.paginate<GhReviewComment>(`${prefix}/pulls/${prId}/comments`)),
    ]);

    // issue 评论 = summary（无线程）
    const summary = issueComments.map((c) => this.mapIssueComment(c));

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
      const pc = this.mapReviewComment(rc);
      pc.replies = (repliesByParent.get(rc.id) ?? []).map((r) => this.mapReviewComment(r));
      return pc;
    });

    return [...summary, ...inline];
  }

  async publishSummaryComment(repo: RepoRef, prId: string, body: string): Promise<PrComment> {
    // summary 评论 = issue 评论（无线程、无锚点）
    const created = await this.client.post<GhIssueComment>(
      `/repos/${repo.projectKey}/${repo.repoSlug}/issues/${prId}/comments`,
      { body },
    );
    return this.mapIssueComment(created);
  }

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

  private mapIssueComment(c: GhIssueComment): PrComment {
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
      // GitHub 无乐观锁：置 0 作「无需并发令牌」哨兵，让 canEdit/canDelete 判定与编辑/删除 IPC
      // 的 version: number 契约统一通过（editComment/deleteComment 忽略 version）。
      version: 0,
    };
  }

  private mapReviewComment(c: GhReviewComment): PrComment {
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
      // 无乐观锁哨兵，同 mapIssueComment。
      version: 0,
    };
  }
}
