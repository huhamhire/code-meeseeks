import type { PrComment, PrCommentAnchor, RepoRef } from '@meebox/shared';
import { PlatformDomainService } from '../context.js';

/** 评论：读写全闭环（summary / inline / reply / edit / delete）。 */
export interface CommentService {
  /** 列出 PR 上的全部已有评论（inline + summary），reply 经 comment.replies 嵌套返回。 */
  listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]>;
  /** 在 PR 上发一条 summary（顶层、不锚到文件）评论。 */
  publishSummaryComment(repo: RepoRef, prId: string, body: string): Promise<PrComment>;
  /** 在 PR diff 上发一条 inline 评论（锚到具体文件 + 行号）。 */
  publishInlineComment(
    repo: RepoRef,
    prId: string,
    anchor: PrCommentAnchor,
    body: string,
  ): Promise<PrComment>;
  /** 在已有评论下回复。 */
  replyToComment(
    repo: RepoRef,
    prId: string,
    parentCommentId: string,
    body: string,
  ): Promise<PrComment>;
  /** 编辑 PR 上的一条评论（改 body 文本）。version 为乐观锁（仅 Bitbucket 校验）。 */
  editComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    version: number,
    body: string,
  ): Promise<PrComment>;
  /** 删除 PR 上的一条评论。version 为乐观锁（仅 Bitbucket 校验）。 */
  deleteComment(repo: RepoRef, prId: string, commentId: string, version: number): Promise<void>;
}

/** 评论领域基类。 */
export abstract class BaseCommentService extends PlatformDomainService implements CommentService {
  abstract listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]>;
  abstract publishSummaryComment(repo: RepoRef, prId: string, body: string): Promise<PrComment>;
  abstract publishInlineComment(
    repo: RepoRef,
    prId: string,
    anchor: PrCommentAnchor,
    body: string,
  ): Promise<PrComment>;
  abstract replyToComment(
    repo: RepoRef,
    prId: string,
    parentCommentId: string,
    body: string,
  ): Promise<PrComment>;
  abstract editComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    version: number,
    body: string,
  ): Promise<PrComment>;
  abstract deleteComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    version: number,
  ): Promise<void>;
}
