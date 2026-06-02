import type { AppInfo, AppPaths } from './app-info.js';
import type { Config } from './config.js';
import type { PlatformUser, PrComment, PrCommit } from './platform.js';
import type {
  LocalPrStatus,
  PollResult,
  ReviewRun,
  ReviewRunTool,
  StoredPullRequest,
} from './poller-contract.js';
import type { PrAgentStatus } from './pr-agent-status.js';

/** ChangedFile / FileContent 跨 IPC 边界用，与 @pr-pilot/repo-mirror 类型同形。 */
export type DiffFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange';

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

/**
 * 仓库 sync 进度事件。RepoMirrorManager 在 clone/fetch 期间通过 onProgress
 * 回调发出；main 进程经 webContents.send 推到 renderer。
 */
export interface SyncProgressEvent {
  /** "host/projectKey/repoSlug" 标识 */
  repo: string;
  phase: 'start' | 'progress' | 'done' | 'error';
  /** simple-git 阶段名（compressing / receiving / resolving / ...） */
  stage?: string;
  /** 0-100 */
  percent?: number;
  /** 人读消息 */
  message?: string;
}

/** Poller tick 完成后广播给 renderer 用于更新"最近一次同步"显示。 */
export interface PollTickEvent {
  /** tick 完成时间 ISO */
  at: string;
  result: PollResult;
}

/**
 * pr-agent run 期间 stdout / stderr 整行流式推送。renderer 拿来在 ChatPane
 * 或日志区域实时显示。一次 run 多条；run 结束后不再发。
 */
export interface PragentRunProgressEvent {
  runId: string;
  line: string;
  stream: 'stdout' | 'stderr';
}

/**
 * 全局唯一活动 run 元信息；活动 run 切换时 main 主动广播 (start / finish / cancel)，
 * renderer 据此切换 chat-pane "运行中" 视图，无需 polling。
 */
export interface ActiveRunInfo {
  runId: string;
  prLocalId: string;
  tool: ReviewRunTool;
  question?: string;
  /** ISO 时间，UI 计时器起点 */
  startedAt: string;
}

/** main → renderer 推送事件。renderer 用 window.api.subscribe 监听。 */
export interface IpcEvents {
  'sync:progress': SyncProgressEvent;
  'poll:tick': PollTickEvent;
  'pragent:runProgress': PragentRunProgressEvent;
  /** 活动 run 变化广播：null 表示当前空闲。renderer 据此切换运行中 UI */
  'pragent:activeChanged': { active: ActiveRunInfo | null };
}

export type IpcEventName = keyof IpcEvents;

export interface ConnectionSummary {
  connectionId: string;
  /** 来自 config 的 display_name */
  displayName: string;
  /** ping 后缓存的当前 PAT 所属用户；ping 未完成或失败时为 null */
  user: PlatformUser | null;
}

/**
 * Typed IPC channel contract.
 *
 * Each entry maps a channel name to its request and response types.
 * The preload bridge and main handlers both reference this map so that
 * Renderer ↔ Main calls stay end-to-end type-safe.
 */
export interface IpcChannels {
  'app:info': { request: void; response: AppInfo };
  'app:paths': { request: void; response: AppPaths };
  'app:prAgentStatus': { request: void; response: PrAgentStatus };
  /** 调 Electron shell.openPath 让 OS 默认编辑器打开 config.yaml */
  'app:openConfigFile': { request: void; response: void };
  /** 打开 Electron DevTools（分离窗口） */
  'app:openDevTools': { request: void; response: void };
  /**
   * 调起系统原生目录选择对话框；用户取消返回 path: null。
   * defaultPath 可空，作为初始定位目录。
   */
  'dialog:pickDirectory': {
    request: { defaultPath?: string; title?: string };
    response: { path: string | null };
  };
  /** 各连接的 ping 后缓存：当前用户 + display_name，Header 用 */
  'app:connections': { request: void; response: ConnectionSummary[] };
  /**
   * 按 (connectionId, slug) 拉用户头像 data URL；主进程缓存命中直接返回。
   * 平台不支持 / 网络失败 / 用户无头像时返回 null，renderer 走 initials 回退。
   */
  'app:userAvatar': {
    request: { connectionId: string; slug: string };
    response: { dataUrl: string } | null;
  };
  'config:read': { request: void; response: Config };
  'prs:list': { request: void; response: StoredPullRequest[] };
  'prs:refresh': { request: void; response: PollResult };
  /** Poller 最近一次完成时间（ISO 或 null）；启动时初始化用 */
  'prs:lastSync': { request: void; response: { at: string | null } };
  'prs:setLocalStatus': {
    request: { localId: string; status: LocalPrStatus };
    response: StoredPullRequest | null;
  };
  /** 同步 PR 所属 repo 的本地镜像（必要时 clone，否则 fetch），返回镜像绝对路径 */
  'repo:sync': {
    request: { localId: string };
    response: { mirrorPath: string; freshClone: boolean };
  };
  /** 列出 PR baseSha → headSha 之间变更的文件（自动先 sync mirror） */
  'diff:listChangedFiles': {
    request: { localId: string };
    response: DiffChangedFile[];
  };
  /** 读取 PR base 或 head 一侧某文件的内容（二进制返回 {binary:true}） */
  'diff:getFileContent': {
    request: { localId: string; side: DiffSide; path: string };
    response: DiffFileContent;
  };
  /** 拉取 PR 上的已有评论（inline + summary 都拉，renderer 自己分） */
  'diff:listComments': {
    request: { localId: string };
    response: PrComment[];
  };
  /**
   * 仅读评论缓存里的总条数 (inline + summary 顶层条目数；不展开 replies)，**不**
   * 打远端。UI 用于 tab 角标 "评论 (N)" 的懒展示：缓存有就直接显示，缓存空就不显示。
   * 用户切到 Comments 标签时触发 `diff:listComments` 拉远端 + 写缓存，下次进 PR
   * 角标就有数字了。
   */
  'diff:commentCountCached': {
    request: { localId: string };
    response: { count: number } | null;
  };
  /** 拉取 PR 包含的 commits，newest first */
  'diff:listCommits': {
    request: { localId: string };
    response: PrCommit[];
  };
  /**
   * 本地 git rev-list 算 PR 引入的 commit 数 (base..head)。完全走本地 bare 镜像，
   * 不打远端；任一 sha 不在镜像 (尚未 sync 到本 PR 范围) → null。
   * UI 用于 Commits 标签页角标的懒展示，跟 diff:commentCountCached 同模式
   */
  'diff:commitCount': {
    request: { localId: string };
    response: { count: number } | null;
  };
  /**
   * 给 head 侧文件跑 git blame；同时返回 PR 引入的 head 行号集合，
   * renderer 能区分"未变更行（出 blame）"vs"PR 改动行（出色带占位）"。
   */
  'diff:getBlame': {
    request: { localId: string; path: string };
    response: {
      /** 仅未变更行的 blame（已过滤掉 PR 改动行） */
      lines: DiffBlameLine[];
      /** PR 引入的 head 行号 (added / modified)，用于 blame 列画色带占位 */
      changedLines: number[];
    };
  };
  /** 计算本地所有 repo 镜像的总占用字节数（设置页用） */
  'repo:getTotalSize': { request: void; response: { totalBytes: number } };
  /** 写入新的 repos_dir 到 config.yaml；重启生效 */
  'config:setReposDir': { request: { reposDir: string }; response: void };
  /** 写入 LLM Provider 配置到 config.yaml；下次 pragent:run 自动用新值 */
  'config:setLlm': { request: { llm: Config['llm'] }; response: void };
  /** 写入 rules.dir + enabled 到 config.yaml；下次 pragent:run 立即生效 (现读规则) */
  'config:setRules': { request: { rules: Config['rules'] }; response: void };
  /**
   * 给指定 PR 查 rules.dir 当前命中的规则 (按 priority desc + path asc 取首条)。
   * 调用方传 tool 区分 /describe / /review (规则可能只对其中一个 tool 生效)。
   * rules.dir 未配置 / 整体禁用 / 无命中 → 返回 null。
   */
  'rules:matchForPr': {
    request: { localId: string; tool: ReviewRunTool };
    response: {
      id: string;
      filePath: string;
      priority: number;
      tools: ReviewRunTool[];
      instructions: string;
    } | null;
  };
  /**
   * 触发一次 pr-agent /describe 或 /review。同步等待执行结束（可能数十秒到数分钟），
   * 期间通过 pragent:runProgress 事件推送 stdout / stderr 行。返回最终 ReviewRun
   * 状态 (succeeded / failed)。pr-agent 不可用时 reject。
   */
  'pragent:run': {
    /**
     * tool='ask' 时 question 必填，作为 pr-agent CLI 的位置参数传给 ask 子命令。
     * tool='describe'/'review' 时 question 字段被忽略。
     */
    request: { localId: string; tool: ReviewRunTool; question?: string };
    response: ReviewRun;
  };
  /**
   * 列出某 PR 的历史 run，newest first。支持时间戳游标分页：
   * - limit：截到 N 条；省略 = 不限（renderer 端慎用，规模大时可能慢）
   * - beforeId：游标，返回 runId **严格小于** 此值的条目；省略 = 不限上界
   *
   * runId 是时序字典序 (`yyyymmdd-HHmmss-mmm`)，"取游标后 N 条" 即"取此时刻之前的 N 条"
   */
  'pragent:listRuns': {
    request: { localId: string; limit?: number; beforeId?: string };
    response: ReviewRun[];
  };
  /** 单条 run 查询（用于 renderer 在事件断流后兜底刷新） */
  'pragent:getRun': {
    request: { localId: string; runId: string };
    response: ReviewRun | null;
  };
  /**
   * 取消当前活动 run。runId 不匹配活动 run / 已结束 → 静默 no-op (返回 ok:false)，
   * 不抛错避免 renderer 处理多余 reject。
   */
  'pragent:cancel': {
    request: { runId: string };
    response: { ok: boolean };
  };
  /** 查询当前活动 run；renderer 启动 / 切窗时拉一下，跟 activeChanged 事件配套兜底 */
  'pragent:active': {
    request: void;
    response: ActiveRunInfo | null;
  };
}

export type IpcChannelName = keyof IpcChannels;

export interface IpcBridge {
  invoke<K extends IpcChannelName>(
    channel: K,
    req: IpcChannels[K]['request'],
  ): Promise<IpcChannels[K]['response']>;
  /** 订阅 main → renderer 推送事件，返回取消订阅函数。 */
  subscribe<E extends IpcEventName>(
    event: E,
    handler: (data: IpcEvents[E]) => void,
  ): () => void;
}
