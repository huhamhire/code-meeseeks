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
  reviewers: Array<PlatformUser & { approved: boolean }>;
}

export interface PingResult {
  ok: boolean;
  serverVersion?: string;
  user?: PlatformUser;
  /** 当 ok=false 时给出的人读原因（设置页显示） */
  reason?: string;
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
}
