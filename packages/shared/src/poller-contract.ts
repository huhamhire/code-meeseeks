import type { PullRequest } from './platform.js';
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

/** pr-agent 跑的工具枚举；后续 /ask /improve 来了再加 */
export type ReviewRunTool = 'describe' | 'review';

export type ReviewRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

/** pr-agent 单次调用失败时的归类，对应 PrAgentRunError.reason */
export type ReviewRunFailureReason = 'timeout' | 'spawn-failed' | 'non-zero-exit' | 'killed';

/**
 * 解析 pr-agent stdout 后得到的单条 finding。category 反映来源：
 * - description: /describe 输出的描述段
 * - code-feedback: 锚到具体文件 / 行的代码建议（有 anchor）
 * - general: 其它 markdown 段（如 estimated effort / score / relevant tests）
 */
export type FindingCategory = 'description' | 'general' | 'code-feedback';

export interface FindingAnchor {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface Finding {
  /** 同一 run 内稳定的 id，便于 UI list-key + 后续 "改为评论草稿" 引用 */
  id: string;
  category: FindingCategory;
  /** 来自 markdown header；可能为空（无明确 section 标题） */
  title?: string;
  /** 原始 markdown body（含格式），UI 用 react-markdown 渲染 */
  body: string;
  /** 仅 category='code-feedback' 时有值 */
  anchor?: FindingAnchor;
}

/**
 * 一次 pr-agent 调用的完整记录。落地为
 * `state/runs/<sanitized-localId>/<runId>.json`。M3-B1 阶段 stdout / stderr
 * 直接落整段，findings 解析留到 M3-B2 填 `findings` 字段。
 */
export interface ReviewRun {
  /** yyyymmdd-HHmmss-ms 时序 id，便于按文件名倒序列出 */
  id: string;
  /** "<connectionId>:<remoteId>"，与 StoredPullRequest.localId 对齐 */
  prLocalId: string;
  tool: ReviewRunTool;
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
  /** "<connectionId>:<remoteId>"，跨连接唯一 */
  localId: string;
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
