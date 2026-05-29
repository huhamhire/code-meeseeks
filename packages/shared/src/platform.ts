export type PlatformKind = 'bitbucket-server' | 'github' | 'gitlab' | 'gitea';

export interface RepoRef {
  /** Bitbucket: project key; GitHub: org/user; GitLab: namespace */
  projectKey: string;
  repoSlug: string;
}

export interface PlatformUser {
  /** 后端 ID（用于 API/匹配） */
  name: string;
  /** 给人看的展示名 */
  displayName: string;
}

/** Reviewer 在 PR 上的当前判定。BBS: APPROVED / NEEDS_WORK / UNAPPROVED */
export type ReviewerStatus = 'approved' | 'needsWork' | 'unapproved';

export interface Reviewer extends PlatformUser {
  status: ReviewerStatus;
}

export interface PullRequest {
  remoteId: string;
  title: string;
  description: string;
  author: PlatformUser;
  state: 'open' | 'merged' | 'declined';
  draft: boolean;
  sourceRef: { displayId: string; sha: string };
  targetRef: { displayId: string; sha: string };
  repo: RepoRef;
  url: string;
  /** ISO timestamps */
  createdAt: string;
  updatedAt: string;
  reviewers: Reviewer[];
  /** 远端是否存在 merge conflict（BBS 走 /merge 端点 conflicted 字段） */
  hasConflict: boolean;
}

export interface PingResult {
  ok: boolean;
  serverVersion?: string;
  user?: PlatformUser;
  /** 当 ok=false 时给出的人读原因（设置页显示） */
  reason?: string;
}

export interface PrCommentAnchor {
  /** 当前路径（renamed 文件给 dst 端） */
  path: string;
  /** 锚定行号 */
  line: number;
  /** 'old' = 锚到 base / FROM；'new' = 锚到 head / TO */
  side: 'old' | 'new';
  /** 锚点对应行的 diff 角色 */
  lineType: 'added' | 'removed' | 'context';
}

export interface PrComment {
  remoteId: string;
  author: PlatformUser;
  body: string;
  /** ISO */
  createdAt: string;
  /** ISO */
  updatedAt: string;
  /** null = PR 顶层 summary 评论；set = inline 评论锚到具体文件行 */
  anchor: PrCommentAnchor | null;
  /** 嵌套 replies (BBS 走 comment.comments[]) */
  replies: PrComment[];
}

/**
 * 跨平台代码托管适配器。一期只实现 Bitbucket Server；M5 扩 GitHub/GitLab/Gitea
 * 时再补 diff / changes / comment / cloneUrl 等更多方法。
 *
 * 业务层（Poller / Publisher / Orchestrator）只依赖此接口，不导入具体 Adapter。
 */
export interface PlatformAdapter {
  readonly kind: PlatformKind;

  /** 连接探测：版本号 + 当前用户。版本低于硬下限时 ok=false 并给 reason。 */
  ping(): Promise<PingResult>;

  /**
   * 返回 ping 期间缓存的当前 PAT 所属用户；ping 未调用或拿不到时返回 null。
   * 同步（仅读缓存），便于 Poller 在每个 PR 上判定 approved 状态时不走 IO。
   */
  getCurrentUser(): PlatformUser | null;

  /** 列出当前 PAT 用户作为 reviewer 待处理的 PR，跨项目跨仓库。 */
  listPendingPullRequests(): Promise<PullRequest[]>;

  /**
   * 返回 git clone URL。一期统一走 SSH（scp-like 形式），认证完全交给系统
   * `~/.ssh/config` + 私钥。BBS 实例若 SSH 端口非 22，需要用户在 ssh config
   * 里给 host 配 Port，否则 git 会用默认 22 失败。
   */
  getCloneUrl(repo: RepoRef): Promise<string>;

  /**
   * 列出 PR 上的全部已有评论（inline + summary）。inline 评论的 anchor 非空，
   * summary 评论的 anchor=null。reply 通过 comment.replies 嵌套返回。
   * 删除的评论会被过滤掉。
   */
  listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]>;
}
