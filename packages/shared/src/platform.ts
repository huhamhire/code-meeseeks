// 顺序即各处平台展示准绳：GitHub → Bitbucket → GitLab，新平台追加末尾（见 PlatformIcon.PLATFORM_META）。
export type PlatformKind = 'github' | 'bitbucket-server' | 'gitlab';

/**
 * 各平台「PR 头」的 git 引用 refspec（fetch 进本地镜像，把 PR 源 sha 钉牢）。源分支被删 / 强推后，
 * `refs/heads/*` 已看不到 head sha，但平台保留了 PR 专属引用——据此 fetch 才能让 `git diff base...head`
 * 不报 "Invalid symmetric difference"。
 *
 * **必须按 PR 号精确取**：GitHub 的 pull 引用 / GitLab 的 merge-requests 引用默认不在 ref 广播里，
 * 通配 fetch 匹配不到（Bitbucket 的 pull-requests 引用会广播、通配可取，二者不同）；按确切编号 fetch
 * 平台才返回。remoteId 非纯数字（异常）→ 返回 null（不构造可疑 ref）。
 */
export function pullRequestHeadRefspec(platform: PlatformKind, remoteId: string): string | null {
  const n = remoteId.trim();
  if (!/^\d+$/.test(n)) return null;
  switch (platform) {
    case 'github':
      return `+refs/pull/${n}/head:refs/pull/${n}/head`;
    case 'gitlab':
      return `+refs/merge-requests/${n}/head:refs/merge-requests/${n}/head`;
    case 'bitbucket-server':
      return `+refs/pull-requests/${n}/from:refs/pull-requests/${n}/from`;
  }
}

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
  /**
   * 稳定否决原因码（中性、不本地化）。GitHub / GitLab 等把派生原因归一到 `@meebox/platform-core`
   * 的 `MergeVetoCode`，前端按码 i18n（`mergeVeto.<code>`）。后台不拼面向用户的中文/本地化文案。
   * 服务端直给人读文案（如 Bitbucket）时可不带 code、改用 `summary`。
   */
  code?: string;
  /** 服务端直给的人读原因（如 Bitbucket summaryMessage）；无 `code` 时展示用。 */
  summary?: string;
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
   * 里带当前 version，否则 409 conflict。GitHub / GitLab 无此语义，置 `0` 作「无需并发令牌」
   * 哨兵——让 canEdit/canDelete 判定与编辑/删除 IPC 的 `version: number` 契约统一通过，
   * 其编辑/删除 API 忽略该值。
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
 * PR 评审决断事件的判定类型。`dismissed` = 决断被撤销/作废（GitHub DISMISSED），
 * 与主动 `unapproved`（撤回赞成）语义相近但来源不同，保留区分供 UI 文案。
 */
export type PrActivityKind = 'approved' | 'needsWork' | 'unapproved' | 'dismissed';

/**
 * PR 活动时间线上的「评审决断」事件（带时间戳）。跨平台中性形状，由各 adapter 从原生活动流
 * 映射：GitHub `/pulls/{n}/reviews`（state + submitted_at）；Bitbucket `/activities`
 * （action=APPROVED/REVIEWED/UNAPPROVED + createdDate）；GitLab 系统 note（approved/
 * unapproved，CE 无审批则取不到）。
 *
 * 仅承载评论 / 提交之外的「决断类」事件——评论走 {@link PrComment}、提交走 {@link PrCommit}，
 * 渲染层把三路按时间归并成一条时间线。平台拿不到历史事件时该方法返回空数组。
 */
export interface PrActivityEvent {
  /** 平台侧事件 id（去重 / React key 用） */
  remoteId: string;
  kind: PrActivityKind;
  /** 触发该决断的用户 */
  actor: PlatformUser;
  /** ISO */
  createdAt: string;
  /** 决断附带正文（GitHub review body 可能带说明）；无则省略 */
  body?: string;
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
 * 平台能力描述符（多平台适配，见 docs/arch/01-platform-adapter.md §2 / §3）。
 * 把无法在所有平台等价实现的能力显式声明，UI 据此 显/隐/灰（降级规则见 §2），业务层据此调策略，
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
  /**
   * 评论正文单换行是否按 hard-break 渲染（单 `\n` → `<br>`）。GitHub / Bitbucket 评论上下文
   * 是（`true`）；GitLab 走标准 CommonMark（单 `\n` 作软换行 = 空格，`false`）。renderer 据此
   * 决定是否启用 remark-breaks，使本地渲染与各平台 web 一致。
   */
  commentHardBreaks: boolean;
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
  /**
   * 是否提供「带时间戳的评审决断活动事件流」（{@link PrActivityEvent}）以支撑活动时间线。
   * GitHub（/reviews）/ Bitbucket（/activities）为 `true`：该 PR 标签页渲染评论 + 提交 + 决断
   * 归并的「活动」时间线。GitLab 为 `false`：无统一活动事件源（CE 无审批、系统 note 解析脆弱），
   * 标签页退化为纯「评论」视图（沿用原行为与文案），不混入提交 / 决断。
   */
  activityTimeline: boolean;
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
