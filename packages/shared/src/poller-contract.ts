import type { PlatformKind, PullRequest } from './platform.js';
import type { PrAgentStrategy } from './pr-agent-status.js';

/**
 * 本地 review 判定。和 BBS reviewer.status 一一对应，UI 由它驱动两个 toggle 按钮：
 * - pending: 默认（UNAPPROVED），尚未给出 review 判定
 * - approved: 已 approve
 * - needs_work: 已标记 NEEDS_WORK
 *
 * 用户在 UI 上点击会同步到远端 BBS（参与者 status），下一轮 poll 再次取回保持一致。
 */
export type LocalPrStatus = 'pending' | 'approved' | 'needs_work';

/**
 * pr-agent 跑的工具枚举：
 * - describe / review：生成 PR 描述 / 代码评审，输出落到工作树的 markdown 文件
 * - ask：自然语言追问，输出走 stdout (没有专属 output 文件)，request 必带 question
 * - improve：逐行代码改进建议；pr-agent local provider 不实现
 *   `publish_code_suggestions`，所以走 `publish_comment` 把汇总 markdown 写到
 *   `review.md` (跟 review / ask 共用)。每条建议形态：
 *     <details><summary>file<br>[start-end]:</summary>...```diff\nold\nnew\n```...</details>
 *   parseReviewOutput 对 tool='improve' 走专门解析路径，把每条 details 拆成
 *   带 anchor (path / startLine / endLine) 的 code-feedback finding。
 *
 * 后续 /reflect 等接进来时往这里加值
 */
export type ReviewRunTool = 'describe' | 'review' | 'ask' | 'improve';

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
  | 'title'             // 建议的 PR 标题
  | 'pr-type'           // 类型标签 (Bug fix / Enhancement / Tests / ...)
  | 'summary'           // /review 顶部总结
  | 'description'       // 主描述段
  | 'walkthrough'       // 文件级走查
  | 'relevant-tests'    // 相关测试
  | 'security'          // 安全发现
  | 'code-feedback'     // /review 单条 finding (带 file:line anchor)
  | 'code-suggestion'   // /improve 单条改进建议 (带 file:line anchor + existing/improved diff)
  | 'effort'            // 评估工作量 1-5
  | 'score'             // 质量分
  | 'general';          // 兜底，未识别

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
   * 发布成功后远端评论 id (e.g., BBS comment id)。用作幂等 key，防止同一 finding
   * 被重复发布；跟 state/posted-comments.json 互为冗余但前者按 finding 维度，
   * 后者按 (finding_id, remote_id) 维度全局索引，用途互补
   */
  posted_remote_id?: string;
}

/**
 * M4 评审 → 发布闭环的"草稿"。详见 ADR-0007。
 *
 * 草稿的生命周期跟 Finding 解耦：
 * - Finding 是 /review 的不可变快照 (跑过什么 AI 说了什么)
 * - Draft 是用户工作中的可变态 (用户编辑 / 拒绝 / 发布的对象)
 *
 * 落盘到 `state/prs/<localId>/drafts.json`，per-PR 目录 (ADR-0006 一致)；PR 退场
 * 时 deleteDir 整树清掉。
 *
 * 状态机：
 *   pending  ──(用户编辑 body)──► edited
 *   pending  ──(用户拒绝)──────► rejected
 *   edited   ──(用户拒绝)──────► rejected
 *   pending / edited  ──(批量发布成功)──► posted
 *   posted   ──► (终态，本地不变；要改远端走 BBS API)
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

/**
 * PR identity 快照：嵌进 ReviewRun (可选) 让 run 文件自描述，不依赖 `prs/index.json`
 * 也能反查所属 PR。M5 归档场景 (PR 已硬清但 run 单独导出) 会需要。
 *
 * 这里复制 `@pr-pilot/poller` 的 PrIdentity 形状到 shared，避免 shared 反向依赖
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
  /** 探测时拿到的 pr-agent 版本（CLI 首行 / docker version 字符串） */
  prAgentVersion: string;
  strategy: PrAgentStrategy;
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
   * 取前 12 hex chars。详见 `@pr-pilot/poller` 的 `prHashId`。
   *
   * 用 hash 而不是拼字符串：
   * - 路径友好 (无 `:` `/` 需要转义，跨平台一致)
   * - 定长 (12 chars)
   * - 不同 platform / repo 同 PR id 不会撞 (platform + group + repo + remote 都纳入哈希源)
   */
  localId: string;
  /**
   * 远端平台类型。让单个 meta.json 自描述，不依赖 prs/index.json 也能知道这条 PR
   * 来自什么平台 —— 跨存储迁移 / 备份 / 离线分析时友好。M3 起 BBS only；M5 接入
   * GitHub / GitLab / Gitea 时无需改 schema
   */
  platform: PlatformKind;
  connectionId: string;
  localStatus: LocalPrStatus;
  /** 首次被 poll 发现的时间，ISO */
  discoveredAt: string;
  /** 最近一次 poll 仍能看到的时间，ISO */
  lastSeenAt: string;
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
