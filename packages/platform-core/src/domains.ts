import type {
  ListPendingOptions,
  PingResult,
  PlatformCapabilities,
  PlatformKind,
  PlatformUser,
  PrActivityEvent,
  PrComment,
  PrCommentAnchor,
  PrCommit,
  PullRequest,
  RepoRef,
  ReviewerStatus,
} from '@meebox/shared';
import type { BinaryResource, PlatformTransport } from './transport.js';

// ---- 领域接口（按业务领域拆分平台连接能力，见 docs/design/platform-layer-refactor.md §3.2）----

/** 连接 / 身份 / 克隆（根领域）：连接探测、当前用户缓存、能力聚合入口、git 克隆 URL。 */
export interface PlatformConnection {
  readonly kind: PlatformKind;
  /** 平台能力描述符（静态，按平台/版本/套餐固定）。聚合自各领域能力声明 + 连接探测细化。 */
  capabilities(): PlatformCapabilities;
  /** 连接探测：版本号 + 当前用户。版本低于硬下限时 ok=false 并给 reason。 */
  ping(): Promise<PingResult>;
  /** 返回 ping 期间缓存的当前 PAT 所属用户；未就绪返回 null（同步，仅读缓存）。 */
  getCurrentUser(): PlatformUser | null;
  /** 注入/恢复当前用户缓存（main 建连接时用本地持久化身份预热，ping 完成后被远端覆盖）。 */
  setCurrentUser?(user: PlatformUser | null): void;
  /** 返回 git clone URL（pat 内嵌 user:PAT / ssh scp-like）。 */
  getCloneUrl(repo: RepoRef): Promise<string>;
}

/** PR 操作：发现、提交 / 活动数据、审批决断、合并。 */
export interface PullRequestService {
  /** 列出待处理 PR，跨项目跨仓库（默认 review-requested；GitHub 按 opts.filter 切换发现范围）。 */
  listPendingPullRequests(opts?: ListPendingOptions): Promise<PullRequest[]>;
  /** 列出 PR 全部提交，**newest first**。 */
  listPullRequestCommits(repo: RepoRef, prId: string): Promise<PrCommit[]>;
  /** 列出 PR 上的「评审决断」活动事件（approve / needs-work / unapprove / dismiss），带时间戳。 */
  listPullRequestActivity(repo: RepoRef, prId: string): Promise<PrActivityEvent[]>;
  /** 把当前用户在该 PR 上的 review 状态写到远端（approved / needsWork / unapproved）。 */
  setPullRequestReviewStatus(repo: RepoRef, prId: string, status: ReviewerStatus): Promise<void>;
  /** 合并 PR 到目标分支（仅应在 mergeStatus.canMerge=true 时调用；不可逆）。 */
  mergePullRequest(repo: RepoRef, prId: string): Promise<void>;
}

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

/** 用户与媒体：头像 / 评论内嵌附件代理（带凭据拉取由平台信任模型把关）。 */
export interface MediaService {
  /** 拉用户头像图片。平台不支持或失败返回 null，调用方走 initials 回退。 */
  getUserAvatar(slug: string, avatarUrl?: string): Promise<BinaryResource | null>;
  /** 评论 body 内嵌图片代理。host 不属当前平台 / 协议无法解析 / 失败 → null。 */
  getAttachment(url: string, repo?: RepoRef): Promise<BinaryResource | null>;
}

/**
 * 平台适配器（根 / 总 client）：领域服务容器。业务层经此按领域取所需服务（`adapter.comments.list(...)`），
 * 不再面对单一巨接口。组合由 {@link composePlatformAdapter} 完成。
 */
export interface PlatformAdapter {
  readonly kind: PlatformKind;
  readonly connection: PlatformConnection;
  readonly pulls: PullRequestService;
  readonly comments: CommentService;
  readonly media: MediaService;
}

// ---- 连接上下文与领域基类（共享连接态 + 各领域可独立维护的实现基座）----

/**
 * 连接上下文：一个平台连接的共享态，由组合器一次构造、注入全部领域服务——统一连接封装实例（传输）+
 * 当前用户缓存。确保「一个连接 = 一个封装实例 = 一份连接态」，各领域不重复持有 transport 或 token。
 */
export interface ConnectionContext {
  /** 平台连接传输（统一连接封装实例）。 */
  readonly transport: PlatformTransport;
  /** 当前 PAT 用户缓存（ping 落地 / setCurrentUser 预热）。 */
  getCurrentUser(): PlatformUser | null;
  setCurrentUser(user: PlatformUser | null): void;
}

/** 默认可变连接上下文实现。 */
export class MutableConnectionContext implements ConnectionContext {
  private user: PlatformUser | null = null;
  constructor(readonly transport: PlatformTransport) {}
  getCurrentUser(): PlatformUser | null {
    return this.user;
  }
  setCurrentUser(user: PlatformUser | null): void {
    this.user = user;
  }
}

/** 领域服务基类：持有共享连接上下文，向子类暴露 transport。各领域基类由此派生。 */
export abstract class PlatformDomainService {
  constructor(protected readonly ctx: ConnectionContext) {}
  protected get transport(): PlatformTransport {
    return this.ctx.transport;
  }
}

/** 连接领域基类：当前用户缓存读写为跨平台共享实现；ping / capabilities / clone 由平台子类实现。 */
export abstract class BaseConnection extends PlatformDomainService implements PlatformConnection {
  abstract readonly kind: PlatformKind;
  abstract capabilities(): PlatformCapabilities;
  abstract ping(): Promise<PingResult>;
  getCurrentUser(): PlatformUser | null {
    return this.ctx.getCurrentUser();
  }
  setCurrentUser(user: PlatformUser | null): void {
    this.ctx.setCurrentUser(user);
  }
  abstract getCloneUrl(repo: RepoRef): Promise<string>;
}

/** PR 操作领域基类。 */
export abstract class BasePullRequestService
  extends PlatformDomainService
  implements PullRequestService
{
  abstract listPendingPullRequests(opts?: ListPendingOptions): Promise<PullRequest[]>;
  abstract listPullRequestCommits(repo: RepoRef, prId: string): Promise<PrCommit[]>;
  abstract listPullRequestActivity(repo: RepoRef, prId: string): Promise<PrActivityEvent[]>;
  abstract setPullRequestReviewStatus(
    repo: RepoRef,
    prId: string,
    status: ReviewerStatus,
  ): Promise<void>;
  abstract mergePullRequest(repo: RepoRef, prId: string): Promise<void>;
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

/** 用户与媒体领域基类。 */
export abstract class BaseMediaService extends PlatformDomainService implements MediaService {
  abstract getUserAvatar(slug: string, avatarUrl?: string): Promise<BinaryResource | null>;
  abstract getAttachment(url: string, repo?: RepoRef): Promise<BinaryResource | null>;
}

/** 领域服务集合，喂给 {@link composePlatformAdapter}。 */
export interface PlatformServices {
  connection: PlatformConnection;
  pulls: PullRequestService;
  comments: CommentService;
  media: MediaService;
}

/** 把四个领域服务组装成根 PlatformAdapter（领域服务容器）。根不含业务逻辑，只持有并暴露各领域。 */
export function composePlatformAdapter(services: PlatformServices): PlatformAdapter {
  return {
    kind: services.connection.kind,
    connection: services.connection,
    pulls: services.pulls,
    comments: services.comments,
    media: services.media,
  };
}
