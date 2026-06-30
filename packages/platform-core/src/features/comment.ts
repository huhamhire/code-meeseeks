import type { PrComment, PrCommentAnchor, RepoRef } from '@meebox/shared';
import { PlatformDomainService } from '../context.js';

/** 评论：读写全闭环（summary / inline / reply / edit / delete）。 */
export interface CommentService {
  /**
   * 列出 PR 上的全部已有评论（inline + summary）。
   *
   * reply 经 comment.replies 嵌套返回，调用方拿到的是已成树的评论列表。
   */
  listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]>;

  /**
   * 在 PR 上发一条 summary 评论（顶层、不锚到文件）。
   */
  publishSummaryComment(repo: RepoRef, prId: string, body: string): Promise<PrComment>;

  /**
   * 在 PR diff 上发一条 inline 评论，锚到具体文件 + 行号。
   */
  publishInlineComment(
    repo: RepoRef,
    prId: string,
    anchor: PrCommentAnchor,
    body: string,
  ): Promise<PrComment>;

  /**
   * 在已有评论下回复。
   */
  replyToComment(
    repo: RepoRef,
    prId: string,
    parentCommentId: string,
    body: string,
  ): Promise<PrComment>;

  /**
   * 编辑 PR 上的一条评论（改 body 文本）。
   *
   * version 为乐观锁，仅 Bitbucket 校验，其余平台忽略。
   */
  editComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    version: number,
    body: string,
  ): Promise<PrComment>;

  /**
   * 删除 PR 上的一条评论。
   *
   * version 为乐观锁，仅 Bitbucket 校验，其余平台忽略。
   */
  deleteComment(repo: RepoRef, prId: string, commentId: string, version: number): Promise<void>;

  /**
   * 切换当前用户对一条评论的某个 emoji 反应（add=true 加上、false 取下）。emoji 为规范化
   * Unicode 字符，由 adapter 翻成自家原生名。kind 区分 summary / inline（GitHub 据此选 issue /
   * review 反应端点；其余平台忽略）。幂等：重复 add / 不存在时 remove 均按成功处理。
   * 仅 `commentReactions` 能力为真的平台实现；不支持的平台抛错。
   */
  toggleReaction(
    repo: RepoRef,
    prId: string,
    commentId: string,
    kind: 'summary' | 'inline',
    emoji: string,
    add: boolean,
  ): Promise<void>;
}

/**
 * 评论领域基类：读写全闭环契约方法留给平台子类按各自端点实现。
 */
export abstract class BaseCommentService extends PlatformDomainService implements CommentService {
  /**
   * 由平台子类实现：拉取 PR 的全部评论并归一为统一评论树。
   */
  abstract listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]>;

  /**
   * 由平台子类实现：发表一条顶层 summary 评论。
   */
  abstract publishSummaryComment(repo: RepoRef, prId: string, body: string): Promise<PrComment>;

  /**
   * 由平台子类实现：在 diff 上发表锚到文件 + 行号的 inline 评论。
   */
  abstract publishInlineComment(
    repo: RepoRef,
    prId: string,
    anchor: PrCommentAnchor,
    body: string,
  ): Promise<PrComment>;

  /**
   * 由平台子类实现：在指定父评论下回复。
   */
  abstract replyToComment(
    repo: RepoRef,
    prId: string,
    parentCommentId: string,
    body: string,
  ): Promise<PrComment>;

  /**
   * 由平台子类实现：编辑评论 body（version 乐观锁按平台决定是否校验）。
   */
  abstract editComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    version: number,
    body: string,
  ): Promise<PrComment>;

  /**
   * 由平台子类实现：删除评论（version 乐观锁按平台决定是否校验）。
   */
  abstract deleteComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    version: number,
  ): Promise<void>;

  /**
   * 由平台子类实现：切换当前用户对评论的 emoji 反应。不支持反应的平台可不覆写（默认抛错）。
   */
  toggleReaction(
    _repo: RepoRef,
    _prId: string,
    _commentId: string,
    _kind: 'summary' | 'inline',
    _emoji: string,
    _add: boolean,
  ): Promise<void> {
    throw new Error('toggleReaction is not supported by this platform');
  }
}
