import type {
  PlatformKind,
  PlatformUser,
  PrCommentAnchor,
  PrDiscoveryFilter,
  PullRequest,
  RepoRef,
} from './platform.js';
import type { PrAgentStrategy } from './pr-agent-status.js';
import type { ReviewRunTool } from './tool-registry.js';

/**
 * 本地 review 判定。和 Bitbucket reviewer.status 一一对应，UI 由它驱动两个 toggle 按钮：
 * - pending: 默认（UNAPPROVED），尚未给出 review 判定
 * - approved: 已 approve
 * - needs_work: 已标记 NEEDS_WORK
 *
 * 用户在 UI 上点击会同步到远端 Bitbucket（参与者 status），下一轮 poll 再次取回保持一致。
 */
export type LocalPrStatus = 'pending' | 'approved' | 'needs_work';

// 工具枚举 ReviewRunTool 见统一注册表 tool-registry（新增工具改那里）。注：improve 的 pr-agent local
// provider 不实现 `publish_code_suggestions`，输出走 review.md（与 review / ask 共用）；parseReviewOutput
// 对 tool='improve' 走专门解析路径，把每条 <details> 建议拆成带 anchor 的 code-feedback finding。

export type ReviewRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * pr-agent 单次调用失败时的归类。
 *
 * 'llm-error' 跟其他 reason 不同 —— pr-agent CLI 本身可能 exit 0 (它内部 catch
 * 了 LLM 错误只 logger.warning 一下)，但 stdout 里能看到 "Failed to generate
 * prediction with any model" / "Error during LLM inference" 之类 marker。
 * parseReviewOutput 检测到这种 marker 时把 status 升格为 'failed' +
 * reason='llm-error'，避免 UI 把 LLM 调用全失败的 run 当"成功完成"展示
 */
export type ReviewRunFailureReason =
  | 'timeout'
  | 'spawn-failed'
  | 'non-zero-exit'
  | 'killed'
  | 'cancelled'
  | 'llm-error';

/**
 * 解析 pr-agent stdout 后得到的单条 finding。category 反映来源：
 * - description: /describe 输出的描述段
 * - code-feedback: 锚到具体文件 / 行的代码建议（有 anchor）
 * - general: 其它 markdown 段（如 estimated effort / score / relevant tests）
 */
export type FindingCategory = 'description' | 'general' | 'code-feedback';

/**
 * 标准化的 pr-agent 输出段落键名。把不同版本 pr-agent 的 section title (可能带
 * **bold** / 大小写不同 / 中英变体) 归一到稳定标识，UI 按 key 决定排序 / 着色 /
 * 是否隐藏 / 后续做特化卡片。
 */
export type PrDocSectionKey =
  | 'title' // 建议的 PR 标题
  | 'pr-type' // 类型标签 (Bug fix / Enhancement / Tests / ...)
  | 'summary' // /review 顶部总结
  | 'description' // 主描述段
  | 'diagram' // 架构图（changes_diagram，mermaid）
  | 'assessment' // 思路建议（注入字段：替代方案 + 倾向性建议，对齐 Qodo High-Level Assessment）
  | 'walkthrough' // 文件级走查
  | 'relevant-tests' // 相关测试
  | 'security' // 安全发现
  | 'code-feedback' // /review 单条 finding (带 file:line anchor)
  | 'code-suggestion' // /improve 单条改进建议 (带 file:line anchor + existing/improved diff)
  | 'ask-summary' // /ask 结构化分段：结论 / 直接回答（高亮、展开）
  | 'ask-analysis' // /ask 结构化分段：过程性分析 / 讨论（默认收起）
  | 'ask-suggestions' // /ask 结构化分段：可执行建议（高亮）
  | 'effort' // 评估工作量 1-5
  | 'score' // 质量分
  | 'general'; // 兜底，未识别

export interface FindingAnchor {
  path: string;
  startLine?: number;
  endLine?: number;
}

/** Finding 严重度：M4 评审发布闭环用，UI 决定 chip 着色 / 排序优先级 */
export type FindingSeverity = 'info' | 'warning' | 'error';

/**
 * Finding 在评审 → 发布闭环中的状态机:
 *   pending  : 默认值，待用户决断
 *   accepted : 用户勾选采纳 (将作为 inline / summary 评论发布)
 *   edited   : 用户改写了内容 (draft_body 含编辑后版本)
 *   rejected : 用户拒绝；不发布
 *   posted   : 已发布到远端 (posted_remote_id 含远端评论 id 用作幂等)
 */
export type FindingStatus = 'pending' | 'accepted' | 'edited' | 'rejected' | 'posted';

/**
 * /improve 单条建议的"前后代码"对比。pr-agent 在 markdown 里用 `diff` 代码块同时
 * 给出 existing + improved 两段内容；解析后我们拆成两份字符串，UI 用单语言 syntax
 * highlight 渲染 (anchor.path 给文件类型)。两边都是片段，不一定能独立运行/编译。
 */
export interface FindingCodeChange {
  existing: string;
  improved: string;
}

export interface Finding {
  /** 同一 run 内稳定的 id，便于 UI list-key + 后续 "改为评论草稿" 引用 */
  id: string;
  category: FindingCategory;
  /**
   * 段落归一键。新解析的 finding 都会带；旧持久化的 run 没有此字段 (回退到 category)。
   * UI 按 sectionKey 决定排序 + 视觉分层
   */
  sectionKey?: PrDocSectionKey;
  /** 来自 markdown header (已剥除 **__ 强调符号)；可能为空 */
  title?: string;
  /** 原始 markdown body（含格式），UI 用 react-markdown 渲染 */
  body: string;
  /** category='code-feedback' / 'code-suggestion' 时有值 */
  anchor?: FindingAnchor;
  /**
   * /improve 建议带的"原代码 → 改进代码"对比。仅 sectionKey='code-suggestion' 时填。
   * UI 用单语言 syntax highlight 渲染前后两个片段
   */
  codeChange?: FindingCodeChange;
  /**
   * /improve 给的重要度评分 1-10。仅 sectionKey='code-suggestion' 时填。
   * 配合 severity (M4 评审决断) 做排序 / 着色：分数 ≥ 8 默认 'warning'，< 5 默认 'info'
   */
  score?: number;
  /**
   * 严重度 (M4)；当前 parser 不填，M4 接 /improve 时按 pr-agent 输出 / rules 补
   * 推断逻辑。UI 默认按 'info' 渲染
   */
  severity?: FindingSeverity;
  /**
   * 发布闭环状态 (M4)；缺省视为 'pending'。所有 finding 默认是 pending，用户在
   * Findings Drawer 上勾选后转 accepted / edited / rejected；发布成功转 posted
   */
  status?: FindingStatus;
  /**
   * 用户编辑后的评论正文。仅 status='edited' 时填；其他状态 UI 直接读 body
   */
  draft_body?: string;
  /**
   * 发布成功后远端评论 id (e.g., Bitbucket comment id)。用作幂等 key，防止同一 finding
   * 被重复发布；跟 state/posted-comments.json 互为冗余但前者按 finding 维度，
   * 后者按 (finding_id, remote_id) 维度全局索引，用途互补
   */
  posted_remote_id?: string;
}

/**
 * M4 评审 → 发布闭环的"草稿"。
 *
 * 草稿的生命周期跟 Finding 解耦：
 * - Finding 是 /review 的不可变快照 (跑过什么 AI 说了什么)
 * - Draft 是用户工作中的可变态 (用户编辑 / 拒绝 / 发布的对象)
 *
 * 落盘到 `state/prs/<localId>/drafts.json`，per-PR 目录；PR 退场
 * 时 deleteDir 整树清掉。
 *
 * 状态机：
 *   pending  ──(用户编辑 body)──► edited
 *   pending  ──(用户拒绝)──────► rejected
 *   edited   ──(用户拒绝)──────► rejected
 *   pending / edited  ──(批量发布成功)──► posted
 *   posted   ──► (终态，本地不变；要改远端走 Bitbucket API)
 */
export interface ReviewDraft {
  /** 唯一稳定 id (uuid 或 runId+findingId 派生)，UI list-key + 持久化引用 */
  id: string;
  /** PR hash localId，跟父目录一致 */
  prLocalId: string;
  /** 锚点：跟 FindingAnchor 一致但 startLine/endLine 必填 (草稿必须 anchor 到具体行) */
  anchor: ReviewDraftAnchor;
  /** 当前评论正文。pending 时 = AI 建议原文；edited 时 = 用户编辑后 */
  body: string;
  /**
   * 来源：AI 建议 (`finding`) vs 用户手动添加 (`manual`)。
   * 用户从 DiffView 行 hover '+' 创建的草稿是 manual；从 ChatPane 跳转的是 finding。
   */
  origin: 'finding' | 'manual';
  /**
   * 仅 origin='finding' 时填，指回源 finding。UI 用它在 ChatPane finding card
   * 上反查关联 Draft 的 status chip 显示
   */
  source?: { runId: string; findingId: string };
  status: 'pending' | 'edited' | 'posted' | 'rejected';
  /** 发布成功后远端 comment id，幂等 key + 跳转链接 */
  posted_remote_id?: string;
  /** ISO */
  createdAt: string;
  /** ISO，每次 update 都刷新 */
  updatedAt: string;
}

export interface ReviewDraftAnchor {
  path: string;
  /** 锚点起始行 (从 1 开始) */
  startLine: number;
  /** 锚点结束行；单行评论 = startLine */
  endLine: number;
  /** 锚到 base (old) 还是 head (new) 侧 */
  side: 'old' | 'new';
}

export interface DraftsFile {
  schema_version: 1;
  drafts: ReviewDraft[];
}

export interface FindingClosuresFile {
  schema_version: 1;
  closures: FindingClosure[];
}

/**
 * PR identity 快照：嵌进 ReviewRun (可选) 让 run 文件自描述，不依赖 `prs/index.json`
 * 也能反查所属 PR。M5 归档场景 (PR 已硬清但 run 单独导出) 会需要。
 *
 * 这里复制 `@meebox/poller` 的 PrIdentity 形状到 shared，避免 shared 反向依赖
 * poller (循环依赖)。两边字段一一对应。
 */
export interface PrIdentitySnapshot {
  platform: PlatformKind;
  connectionId: string;
  group: string;
  repo: string;
  remoteId: string;
  url?: string;
}

/**
 * 一次 pr-agent 调用的完整记录。落地为 `state/prs/<localId>/runs/<runId>.json`，
 * 与 PR 的 meta.json / comments.json 同目录，PR 退场时一并清理。
 */
/**
 * 本次 run 的 LLM token 用量（真实值，来自 API response.usage，经 litellm callback
 * 捕获，见 sitecustomize.py）。一次 run 可能多次调用 LLM（retry / 多 tool），这里是
 * **累加**值，calls 记录调用次数。历史 run / 非 embedded / 流式模型可能缺失 → 全可选。
 */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** 本次 run 捕获到的 LLM 调用次数（累加来源） */
  calls?: number;
  /** 提示缓存读取（cache_read）token 数：promptTokens 的一部分，供 UI 拆分展示「↑总量 (cache N)」。
   *  CLI 路径取自 claude/codex usage，API 路径取自 litellm（Anthropic cache_read / OpenAI cached_tokens）。
   *  缺失或为 0 = 无缓存命中信息（UI 不展示该括号）。 */
  cacheReadTokens?: number;
  /** 模型实际交互轮次：CLI agentic 模式为本次 run 内部累计的 num_turns（可远大于 calls）；
   *  其它情况回退为 LLM 调用次数（calls）。≤1 时 UI 不单独展示。 */
  turns?: number;
}

export interface ReviewRun {
  /** yyyymmdd-HHmmss-ms 时序 id，便于按文件名倒序列出 */
  id: string;
  /** PR hash localId (12 hex chars)，跟 StoredPullRequest.localId 对齐 */
  prLocalId: string;
  /**
   * PR identity 快照 (可选)；目前 M3 默认不填，UI 始终从 meta.json 读 PR 信息。
   * 留 schema 位给 M5 归档：导出单个 run 文件时能凭此快照反查远端 PR / 跳转 URL，
   * 即使本地 `prs/<hash>/` 已经被硬清
   */
  prIdentitySnapshot?: PrIdentitySnapshot;
  tool: ReviewRunTool;
  /** /ask 工具的问题内容；其他 tool 不填。UI 把它当用户发言渲染在 run 卡片之上 */
  question?: string;
  /** 探测时拿到的 pr-agent 版本（CLI 首行 / 嵌入式查出的 pr-agent 版本） */
  prAgentVersion: string;
  strategy: PrAgentStrategy;
  /**
   * 本次 run 使用的 LLM 模型 ID — 取自启动时 active LlmProfile.model (经过
   * normalizeModel 加 provider 前缀的形态，e.g., `openai/qwen-plus` /
   * `deepseek/deepseek-chat`)。
   *
   * 历史 run 没存这字段 (undefined)，UI 应能 graceful 处理。新 run 在 startReviewRun
   * 入口填上，让 ChatPane 在 meta 行展示"哪一次 review 用的哪个模型"，方便回看
   * 不同 profile 出的结果差异
   */
  model?: string;
  status: ReviewRunStatus;
  /** ISO 启动时间 */
  startedAt: string;
  /** ISO 结束时间，running 状态下为 undefined */
  finishedAt?: string;
  /** 运行墙钟 (ms) */
  durationMs?: number;
  /** 进程退出码；超时 / 信号杀 / 启动失败时可能为 -1 或 undefined */
  exitCode?: number;
  errorReason?: ReviewRunFailureReason;
  errorMessage?: string;
  /** 原始 stdout 文本；M3-B2 解析成 findings 后仍保留供"看原文"调试 */
  stdout?: string;
  /** 原始 stderr 文本 */
  stderr?: string;
  /** 解析后的 findings；succeeded run 才填，failed 也可能部分有 */
  findings?: Finding[];
  /** 概要 (取首个 ## section 标题 / 描述首行)，UI list 上显示 */
  summary?: string;
  /** 本次 run 的真实 LLM token 用量（累加）；缺失 = 未捕获到（见 TokenUsage） */
  tokenUsage?: TokenUsage;
  /**
   * 复评引用：本次 /ask 是对先前 review/improve run 某条 finding 的「复评」时，记下被引用的源
   * finding（前向链）。UI 据此在 /ask 卡片上展示「复评自 <file:line>」徽标 + 裁决动作。
   * 仅 tool='ask' 且经「引用」触发时填。
   */
  referencedFinding?: { runId: string; findingId: string; anchor?: FindingAnchor };
  /**
   * 复评裁决：解析自复评 /ask 输出的 `<verdict>` 段——replace=给取代性新评论 / keep=原评论成立 /
   * drop=原评论不成立。驱动 UI 的采纳 / 关闭动作。模型未给则 undefined（UI 仅展示、不出裁决动作）。
   */
  askVerdict?: AskVerdict;
}

/** 复评裁决：取代原评论 / 保留原评论 / 撤销原评论。 */
export type AskVerdict = 'replace' | 'keep' | 'drop';

/**
 * finding 关闭关系：一条被复评 /ask「取代 / 撤销」而关闭的源 finding（独立于本地草稿语义，仅作用于
 * ChatPane finding 卡片的关闭态 + 双向互链）。按 (runId, findingId) 标识源 finding。
 */
export interface FindingClosure {
  /** 源 finding 所在的 review/improve run id */
  runId: string;
  /** 源 finding id */
  findingId: string;
  /** 关闭它的复评 /ask run id（用于卡片互链） */
  byAskRunId: string;
  /** 触发关闭的裁决（replace=被取代 / drop=被撤销） */
  verdict: AskVerdict;
  /** ISO 关闭时间 */
  createdAt: string;
}

export interface ReviewRunFile {
  schema_version: 1;
  run: ReviewRun;
}

/**
 * 状态库里存的 PR：在远端字段之上叠加本地维度（归属连接、本地状态、发现/最后看到时间）。
 * 既在主进程持久化用，也是 renderer 经由 IPC 拿到的形状。
 */
export interface StoredPullRequest extends PullRequest {
  /**
   * PR 在本地状态体系的唯一标识：sha1(platform|connectionId|group|repo|remoteId)
   * 取前 12 hex chars。详见 `@meebox/poller` 的 `prHashId`。
   *
   * 用 hash 而不是拼字符串：
   * - 路径友好 (无 `:` `/` 需要转义，跨平台一致)
   * - 定长 (12 chars)
   * - 不同 platform / repo 同 PR id 不会撞 (platform + group + repo + remote 都纳入哈希源)
   */
  localId: string;
  /**
   * 远端平台类型。让单个 meta.json 自描述，不依赖 prs/index.json 也能知道这条 PR
   * 来自什么平台 —— 跨存储迁移 / 备份 / 离线分析时友好。M3 起 Bitbucket only；M5 接入
   * GitHub / GitLab 时无需改 schema
   */
  platform: PlatformKind;
  connectionId: string;
  localStatus: LocalPrStatus;
  /**
   * 该 PR 命中的发现分类（GitHub：review-requested/created/assigned/mentioned 的子集）。
   * poller 一轮把各分类都抓回来并 union 打标；renderer 据此本地过滤标签页，切换不再拉远端。
   * 不支持分类的平台（Bitbucket）为空数组。
   */
  discoveryFilters: PrDiscoveryFilter[];
  /** 首次被 poll 发现的时间，ISO */
  discoveredAt: string;
  /** 最近一次 poll 仍能看到的时间，ISO */
  lastSeenAt: string;
  /**
   * 「未读」标记（派生值，由 `listStoredPullRequests` 据索引里的已读水位计算后填上；持久化的 meta.json
   * 不含此字段）。为真表示自用户上次查看该 PR 后发生了**与我相关**的新事件：源分支推了新 commit、或出现
   * 了 @我 / 回复我的新评论。UI 据此在列表项上点一个未读圆点。用户打开 PR 即清除（推进已读水位）。
   */
  unread?: boolean;
  /**
   * 「@我 / 回复我」未读评论条数（派生值，同 `unread` 由 `listStoredPullRequests` 据已读水位计算填上，meta.json
   * 不含）。与未读圆点**并存、互不替代**：圆点照常按新到达 / 新 commit / 点名回复亮，本计数仅额外给出点名/回复你
   * 的未读条数。已在 poll 端封顶 10，故 ≤ 10；UI 满额显示「10+」。0 表示无此类未读（不渲染计数）。
   */
  unreadMentionCount?: number;
}

export interface PollResult {
  /** 本轮所有连接合并返回的 PR 总数 */
  fetched: number;
  /** 比上次 updatedAt 有变化的 PR 数 */
  changed: number;
  /** 本轮新增的 PR 数 */
  added: number;
  /** 本轮被剪除的 PR 数（远端已 merge/decline，或当前用户不再是 reviewer） */
  removed: number;
  /** poll 失败的连接数 */
  errors: number;
}

/**
 * 系统通知事件类型（与设置页开关一一对应）：
 * - `new_pr` / `mention` / `reply`：面向「待我评审」等——新 PR / 被 @ / 被回复。
 * - `authored_comment` / `authored_needs_work` / `authored_conflict`：面向「我创建的」PR（作者为本人）——
 *   收到他人新评论 / 被评审标记需修改 / 出现合并冲突。
 */
export type PollNotificationKind =
  | 'new_pr'
  | 'mention'
  | 'reply'
  | 'authored_comment'
  | 'authored_needs_work'
  | 'authored_conflict';

/**
 * Poll 本轮新发生的「值得提醒」事件，由 poller 经 onNotify 投影给主进程（用于弹系统通知）。仅在**已有基线**
 * （非首轮 / PR 此前已知）时产出，避免首启 / 批量涌入时通知风暴；带游标的事件（mention/reply/authored_comment）
 * 仅当评论时间晚于历史游标才计；authored_needs_work / authored_conflict 仅在对应状态发生新迁移时才产出。
 */
export interface PollNotificationEvent {
  kind: PollNotificationKind;
  /** 事件所属 PR 的本地 id */
  localId: string;
  /** 事件所属连接 id（头像缓存键 + 取 adapter 拉头像用） */
  connectionId: string;
  /** 远端 PR 编号（如 #123），用于通知正文 */
  remoteId: string;
  /** PR 标题，用于通知正文 */
  title: string;
  /** PR 所在仓库，用于通知正文展示「项目 / 仓库」 */
  repo: RepoRef;
  /**
   * 发起人（通知头像）：new_pr=PR 作者；mention/reply/authored_comment=触发本轮该类事件的最新一条评论作者；
   * authored_needs_work=新标记需修改的评审人；authored_conflict=PR 作者（无具体发起人）。
   */
  actor: PlatformUser;
  /** mention / reply / authored_comment：本轮新增条数；其余省略 */
  count?: number;
  /**
   * 触发事件的最新一条评论的定位信息（通知点击跳转用）。`anchor` 非空=inline 评论（可跳 diff 行），
   * 为 null=summary 评论（打开「活动」对话标签）。仅 mention / reply / authored_comment 带此字段。
   */
  comment?: { remoteId: string; anchor: PrCommentAnchor | null };
}
