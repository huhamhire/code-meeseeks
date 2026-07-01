import type {
  PlatformCapabilities,
  PlatformUser,
  ReviewRunOrigin,
  ReviewRunTool,
} from '@meebox/shared';

/** ChangedFile / FileContent 跨 IPC 边界用，与 @meebox/repo-mirror 类型同形。 */
export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';

export interface DiffChangedFile {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  similarity?: number;
}

export type DiffFileContent = { binary: false; content: string } | { binary: true };

export type DiffSide = 'base' | 'head';

/** 单行 blame 信息（main 跑 git blame --porcelain，renderer 渲染左侧列）。 */
export interface DiffBlameLine {
  line: number;
  commit: string;
  author: string;
  authorEmail: string;
  authorDate: string;
  summary: string;
}

export interface ConnectionSummary {
  connectionId: string;
  /** 来自 config 的 display_name */
  displayName: string;
  /** ping 后缓存的当前 PAT 所属用户；ping 未完成或失败时为 null */
  user: PlatformUser | null;
  /** 该连接所属平台的能力描述符；渲染层据此 显/隐/灰（多平台降级，见 platform.ts） */
  capabilities: PlatformCapabilities;
}

/**
 * 一个 pr-agent run 的元信息，覆盖"正在跑 (active)"和"排队中 (waiting)"两种状态。
 *
 * - active：`startedAt` 是 ISO 启动时间，UI 计时器起点
 * - waiting：`startedAt` 为 null，UI 显示"排队中"+ enqueuedAt
 *
 * 入队即生成 runId (跟最终落盘的 ReviewRun.id 一致；queued 状态不写盘，等真正
 * 开始时 startReviewRun 才落 disk)。这让 `pragent:cancel(runId)` 在 queued/active
 * 两种状态下都能用同一个 id 引用。
 */
export interface PragentRunInfo {
  runId: string;
  prLocalId: string;
  /** 仓库 slug 与 PR 号（队列展示用，避免只显示 localId hash）。 */
  repoSlug: string;
  prNumber: string;
  tool: ReviewRunTool;
  question?: string;
  /** 触发来源：user（手动发起）/ agent（编排派发）。ChatPane 据此为 user 来源的运行中 run 补命令回显气泡。 */
  origin: ReviewRunOrigin;
  /** 入队时间，ISO */
  enqueuedAt: string;
  /** 开始执行时间，ISO；waiting 状态为 null */
  startedAt: string | null;
}

/** 兼容旧引用：active 状态本质就是 startedAt 非空的 PragentRunInfo */
export type ActiveRunInfo = PragentRunInfo;
