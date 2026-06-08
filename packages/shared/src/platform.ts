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
  /**
   * URL 友好的 slug，平台特定。Bitbucket 里 user.slug 可能与 user.name 大小写不同，
   * 走 avatar 等 URL 路径的接口必须用 slug；缺失时调用方走 name 兜底。
   */
  slug?: string;
  /**
   * 头像直链（平台返回的 avatar_url）。有则优先按此 URL 拉头像——GitHub 机器人
   * （login 形如 `foo[bot]`）没有 `github.com/<login>.png`，必须用 avatar_url 才取得到。
   */
  avatarUrl?: string;
}

/** Reviewer 在 PR 上的当前判定。Bitbucket: APPROVED / NEEDS_WORK / UNAPPROVED */
export type ReviewerStatus = 'approved' | 'needsWork' | 'unapproved';

export interface Reviewer extends PlatformUser {
  status: ReviewerStatus;
}

/**
 * 一条阻止合并的原因（merge check 否决项）。跨平台中性形状：
 * - Bitbucket: `/merge` 端点 vetoes[]，summary=summaryMessage，detail=detailedMessage
 * - GitHub: required status / required reviews 未满足项
 * - GitLab: detailed_merge_status 的具体阻塞原因
 */
export interface MergeVeto {
  /** 简短原因，UI 一行展示（Bitbucket summaryMessage） */
  summary: string;
  /** 详细原因，hover / 展开展示，可能缺省（Bitbucket detailedMessage） */
  detail?: string;
}

/**
 * 远端对 PR 的"可合并状态"判定。冲突在这里收敛成一种维度，PR.hasConflict
 * 只是 `conflicted` 的派生镜像（保留兼容现有冲突角标）。
 *
 * Bitbucket 一次 `/merge` 请求即可拿全：canMerge / conflicted / vetoes 同源，无额外开销。
 */
export interface MergeStatus {
  /** 远端判定当前是否可直接合并（Bitbucket canMerge）。false 时 vetoes 给出逐条原因 */
  canMerge: boolean;
  /** 是否存在 merge conflict（Bitbucket conflicted / outcome=CONFLICTED*） */
  conflicted: boolean;
  /**
   * 阻止合并的逐条原因（Bitbucket vetoes）。canMerge=true 时通常为空。
   * 例：必填 reviewer 未全部 approve、未通过的 build、分支保护规则等。
   */
  vetoes: MergeVeto[];
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
  /**
   * 远端可合并状态：能否合并 + 逐条阻塞原因（含冲突）。
   * Bitbucket 走 `/merge` 端点，canMerge / conflicted / vetoes 同源一次拉全。
   */
  mergeStatus: MergeStatus;
  /**
   * 远端是否存在 merge conflict。**派生镜像** = `mergeStatus.conflicted`，
   * 保留独立字段是为了兼容现有冲突角标 (PrItem) 的直接读取；新代码优先读
   * `mergeStatus`。adapter 写入时两者必须保持一致。
   */
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

/**
 * PR 上的单条提交。跨平台中性形状；Bitbucket / GitHub / GitLab 都映射到这一份。
 *
 * `parents` 长度可判定是否 merge commit (>1 = merge)。`url` 给 UI 跳转用。
 */
export interface PrCommit {
  /** 完整 40-char SHA-1 */
  sha: string;
  /** 短 SHA (Bitbucket displayId / GitHub sha[:7])，UI 默认展示 */
  abbreviatedSha: string;
  /** 完整 commit message (含正文)。UI 展示首行作为 subject，hover/展开看 body */
  message: string;
  author: PlatformUser;
  /** ISO；author = 写代码的人 */
  authoredAt: string;
  /** 通常 = author 但 rebase / amend 等场景会变；可选 */
  committer?: PlatformUser;
  /** ISO；committer = 实际落库的人 */
  committedAt: string;
  /** 父提交 SHA 列表；长度 >1 表示 merge commit */
  parents: string[];
  /** 平台侧 commit 详情页 URL，可选 */
  url?: string;
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
  /** 嵌套 replies (Bitbucket 走 comment.comments[]) */
  replies: PrComment[];
  /**
   * 远端版本号 (乐观锁)。Bitbucket 走 0/1/2... 单调递增；DELETE / PUT 时必须在 query
   * 里带当前 version，否则 409 conflict。其他平台没这语义可以留 undefined，
   * adapter 实现时按需带上 / 兜底 0
   */
  version?: number;
  /**
   * main 端预判的"是否可由当前 PAT 用户删除"。综合：
   *   - author.name === currentUser.name (PAT 缓存)
   *   - replies.length === 0 (Bitbucket 拒删有 reply 的)
   *   - version 字段存在 (DELETE 必备乐观锁)
   *
   * renderer 端不再自己比对作者名 / 检查 reply / 检查 version — 直接读这个 flag。
   * 跨 PR / 跨 connection 时，main 端用 PR 所属 adapter 的 cachedUser 判断，
   * renderer 不需要透传 currentUserName
   */
  canDelete?: boolean;
  /**
   * main 端预判的"是否可编辑"。Bitbucket 跟 canDelete 区别在不要求 reply.length===0
   * (带 reply 的评论也允许改 body)；其它同源：作者匹配 + 有 version
   */
  canEdit?: boolean;
  /**
   * 评论种类（多平台抽象）：'summary' = PR 级讨论；'inline' = 锚到文件行。
   * 现状 anchor 是否为 null 已能区分；本字段是 GitHub（issue/review 评论分两套 API）/
   * GitLab（note/discussion）归一时的显式标注，便于 UI 与回写。可选，旧数据不填。
   */
  kind?: 'summary' | 'inline';
  /**
   * 线程标识（回复目标的抽象）。Bitbucket=父评论 id、GitHub=review-comment id、
   * GitLab=discussion id。reply 时透传给 adapter；Bitbucket 现走 remoteId 即可。
   */
  threadId?: string;
  /** 平台原生 id（回写 / 幂等用，与 remoteId 同源但语义独立保留扩展空间）。 */
  nativeId?: string;
}

/**
 * PR 的 diff 基准 sha（行内评论发布锚点用）。GitHub 用 `headSha` 作 commit_id；
 * GitLab 用三者拼 position；Bitbucket 不需要（忽略）。adapter 可按 prId 内部拉取，
 * 也可由调用方（已持 PR meta + 本地镜像 sha）传入，避免每次发布多打一次 API。
 */
export interface PrDiffRefs {
  /** head（源分支最新）sha */
  headSha: string;
  /** base（目标分支 / merge-base）sha */
  baseSha: string;
  /** GitLab position 需要的 start sha；其它平台可空 */
  startSha?: string;
}

/**
 * 平台能力描述符（多平台适配，见 docs/design/multi-platform-adapter.md §3.1 / §8）。
 * 把无法在所有平台等价实现的能力显式声明，UI 据此 显/隐/灰（§9 降级），业务层据此调策略，
 * 避免在调用处 try/catch 猜或写 `if (platform === ...)`。
 */
export interface PlatformCapabilities {
  /** 支持的 review 决断（GitLab CE 可能为 [] 或 ['approved','unapproved']） */
  reviewStatuses: ReadonlyArray<ReviewerStatus>;
  /** 是否支持行内评论 */
  inlineComments: boolean;
  /** 是否支持多行行内评论 */
  inlineMultiline: boolean;
  /** 评论删改是否需要 version 乐观锁（仅 Bitbucket） */
  commentOptimisticLock: boolean;
  /** 合并否决项保真度：'full' 逐条可得（Bitbucket/GitLab）；'partial' 只能近似（GitHub） */
  mergeVetoFidelity: 'full' | 'partial';
  /** 发现端点是否强限流（GitHub search 30/分）→ 该平台轮询间隔单独拉长 */
  discoveryRateLimited: boolean;
  /**
   * 平台提供的 PR 发现分类（GitHub 仪表盘四类）。poller 一轮把这些分类都抓回来、给 PR 打标，
   * renderer 据此本地过滤标签页。为空 / 省略 = 平台只有单一「待我评审」发现，无分类标签。
   */
  discoveryFilters?: ReadonlyArray<PrDiscoveryFilter>;
  /** 评论线程是否可「解决 / Resolve」+ 折叠（GitHub/GitLab 有，Bitbucket 无） */
  resolvableThreads: boolean;
  /** 是否支持行内代码 suggestion「一键应用」（GitHub/GitLab 有，Bitbucket 无） */
  suggestions: boolean;
  /** 决断 + 行内评论是否可成组提交（pending review）；映射到本地草稿池→批量发布 */
  reviewGrouping: boolean;
}

/**
 * PR 发现筛选分类（运行时筛选，不持久化）。目前仅 GitHub 适配器据此切换 search 限定词，
 * 对齐 GitHub 仪表盘的四类；其他平台忽略此参数、维持各自的「待我评审」语义。
 * - `review-requested`（默认）：请求当前用户评审的 PR。
 * - `created`：当前用户创建的 PR。
 * - `assigned`：指派给当前用户的 PR。
 * - `mentioned`：提及当前用户的 PR。
 */
export type PrDiscoveryFilter = 'review-requested' | 'created' | 'assigned' | 'mentioned';

/** 发现 PR 时的可选项；filter 缺省按 review-requested。 */
export interface ListPendingOptions {
  filter?: PrDiscoveryFilter;
}

/**
 * 跨平台代码托管适配器。一期只实现 Bitbucket Server；M5 扩 GitHub/GitLab
 * 时再补 diff / changes / comment / cloneUrl 等更多方法。
 *
 * 业务层（Poller / Publisher / Orchestrator）只依赖此接口，不导入具体 Adapter。
 */
export interface PlatformAdapter {
  readonly kind: PlatformKind;

  /**
   * 平台能力描述符（静态，按平台/版本/套餐固定）。UI 据此 显/隐/灰、业务层据此调策略。
   * 同步返回（实现内可读 ping() 缓存的版本/套餐信息细化，如 GitLab CE vs Premium）。
   */
  capabilities(): PlatformCapabilities;

  /** 连接探测：版本号 + 当前用户。版本低于硬下限时 ok=false 并给 reason。 */
  ping(): Promise<PingResult>;

  /**
   * 返回 ping 期间缓存的当前 PAT 所属用户；ping 未调用或拿不到时返回 null。
   * 同步（仅读缓存），便于 Poller 在每个 PR 上判定 approved 状态时不走 IO。
   */
  getCurrentUser(): PlatformUser | null;

  /**
   * 列出待处理 PR，跨项目跨仓库。默认（review-requested）= 当前 PAT 用户作为 reviewer 待评审；
   * GitHub 适配器按 opts.filter 切换发现范围（created/assigned/mentioned），其他平台忽略。
   */
  listPendingPullRequests(opts?: ListPendingOptions): Promise<PullRequest[]>;

  /**
   * 返回 git clone URL。一期统一走 SSH（scp-like 形式），认证完全交给系统
   * `~/.ssh/config` + 私钥。Bitbucket 实例若 SSH 端口非 22，需要用户在 ssh config
   * 里给 host 配 Port，否则 git 会用默认 22 失败。
   */
  getCloneUrl(repo: RepoRef): Promise<string>;

  /**
   * 列出 PR 上的全部已有评论（inline + summary）。inline 评论的 anchor 非空，
   * summary 评论的 anchor=null。reply 通过 comment.replies 嵌套返回。
   * 删除的评论会被过滤掉。
   */
  listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]>;

  /**
   * 列出 PR 包含的全部提交，**newest first** (最新一条在数组开头)。
   * 跨平台契约：Bitbucket 走 /pull-requests/{id}/commits，GitHub /pulls/{id}/commits，
   * GitLab /merge_requests/{iid}/commits。返回前已剥掉平台特定字段，UI 直接渲染。
   */
  listPullRequestCommits(repo: RepoRef, prId: string): Promise<PrCommit[]>;

  /**
   * 拉用户头像图片。返回原始字节 + content-type，main 进程负责缓存与转 data URL；
   * renderer 不直接 fetch（无 token、无法跨 origin 取私有 Bitbucket 资源）。
   * 有 avatarUrl（平台返回的直链）时优先按它拉——GitHub 机器人靠它才取得到头像；
   * 否则按 slug 推导。平台不支持或拉取失败返回 null，调用方走 initials 回退。
   */
  getUserAvatar(
    slug: string,
    avatarUrl?: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null>;

  /**
   * 评论 body 内嵌图片代理：`<img src>` 无法发 Authorization 头取私有 Bitbucket 资源，
   * 必须经 main 端用 PAT 拉。url 可以是绝对 / 相对，也可以是 platform-specific
   * 内部协议 (Bitbucket 的 `attachment:HASH`)；repo 给协议解析提供上下文。
   * host 不属于当前 platform / 协议无法解析 → 返回 null 让 renderer 退回原生
   * `<img>`。失败 (404 / 网络) 返回 null
   */
  getAttachment(
    url: string,
    repo?: RepoRef,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null>;

  /**
   * 把当前用户在该 PR 上的 review 状态写到远端。
   * - approved / needsWork: 标记
   * - unapproved: 撤销之前的标记，回到默认
   *
   * 需要 ping() 已经跑过、cachedUser 已经落地，否则无法构造端点 (Bitbucket 需要 userSlug)。
   * 失败抛 PlatformError 子类；调用方决定是否回滚本地状态。
   */
  setPullRequestReviewStatus(
    repo: RepoRef,
    prId: string,
    status: ReviewerStatus,
  ): Promise<void>;

  /**
   * 合并 PR 到目标分支。仅应在 mergeStatus.canMerge=true 时调用（上层据此控制
   * 入口可见性）；远端仍会再次校验，未通过 (冲突 / veto / 权限) 抛 PlatformError。
   *
   * Bitbucket: POST /pull-requests/{id}/merge?version={prVersion}。version 是乐观锁，
   * 必须是当前最新值——adapter 内部先拉一次 PR 拿 version 再提交，避免用缓存旧值
   * 触发 409。合并成功后远端 PR 转 MERGED，会从 reviewer pending 列表消失，
   * 调用方应触发一轮 poll 让本地软删收尾。
   *
   * 不可逆操作；merge 策略 (ff / no-ff / squash) 由远端仓库设置决定，本方法不指定。
   */
  mergePullRequest(repo: RepoRef, prId: string): Promise<void>;

  /**
   * 在已有评论下回复。Bitbucket: POST /comments with parent.id；其他平台 (GitHub
   * review comment / GitLab note 等) 各自映射。返回新创建的评论；调用方刷新
   * comments cache 让 UI 立刻看到 reply
   */
  replyToComment(
    repo: RepoRef,
    prId: string,
    parentCommentId: string,
    body: string,
  ): Promise<PrComment>;

  /**
   * 在 PR diff 上发一条 inline 评论 (锚到具体文件 + 行号)。这是 M4 草稿发布闭环
   * 的 sink —— 本地 ReviewDraft 经此方法落到远端，成功后返回新评论 (含 remoteId
   * 让本地 draft 回写 posted_remote_id 做幂等)。
   *
   * Bitbucket: POST /pull-requests/{id}/comments，payload `{text, anchor:{path, line,
   * lineType, fileType, srcPath?}}`。anchor.line + lineType + fileType 三元组必须
   * 跟该行在 diff 里的真实角色一致 —— Bitbucket 会校验，对不上回 400。
   *
   * 调用方传 `PrCommentAnchor` (跨平台中性形状)，adapter 内部翻成平台特定 anchor。
   * `lineType` 不知道时调用方传 'context' 作为最稳保守值，但 Bitbucket 上 added 行评论
   * 必须传 'added'，否则也会 400 —— 这是调用方的责任 (DraftZone 创建时已经知道
   * 这一行在 diff 里的角色)。
   *
   * 失败抛 PlatformError 子类；批量调用方决定是否整批回滚或继续下一条
   */
  publishInlineComment(
    repo: RepoRef,
    prId: string,
    anchor: PrCommentAnchor,
    body: string,
  ): Promise<PrComment>;

  /**
   * 删除 PR 上的一条评论。
   *
   * - 只允许删除自己作者的评论。调用方在 UI 层先做"作者==当前用户"判定再触发，
   *   adapter 这一层假设上层已校验；远端层面 Bitbucket 也会再次校验，无权时回 403
   * - Bitbucket 强制要求带 `version` 防并发 — 拉评论树时已经记到 PrComment.version，
   *   调用方透传过来；version 跟远端不一致回 409 (用户在别处先改过)，让上层
   *   提示"远端已更新，请刷新后重试"
   * - 已有 reply 的评论 Bitbucket 默认拒绝删 (回 409 + 描述)，跟 web UI 行为一致
   *
   * 跨平台契约：返回 void，调用方在删除成功后应清空缓存 + 广播 comments:changed
   */
  deleteComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    version: number,
  ): Promise<void>;

  /**
   * 编辑 PR 上的一条评论 (改 body 文本)。
   *
   * Bitbucket: PUT /pull-requests/{id}/comments/{cid}，payload `{text, version}`，
   * 跟删除一样用 version 做乐观锁；不一致回 409。返回更新后的 PrComment (含
   * 新 version + 新 updatedAt)，UI 据此乐观替换或直接 force-refresh 评论树。
   *
   * 跟 deleteComment 同语义守卫：只允许编辑自己作者的评论，上层做"作者==当前
   * 用户"判定。带 reply 的评论 Bitbucket **允许编辑** (只删才禁，区别于 delete)
   */
  editComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    version: number,
    body: string,
  ): Promise<PrComment>;
}
