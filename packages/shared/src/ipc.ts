import type { AgentRecommendationVerdict, AgentSession, AgentStep } from './agent-contract.js';
import type { AppInfo, AppPaths, UpdateCheckResult } from './app-info.js';
import type { Config } from './config.js';
import type { SupportedLanguage } from './language.js';
import type {
  PingResult,
  PlatformCapabilities,
  PlatformKind,
  PlatformUser,
  PrComment,
  PrCommit,
} from './platform.js';
import type {
  LocalPrStatus,
  PollResult,
  ReviewDraft,
  ReviewRun,
  ReviewRunTool,
  StoredPullRequest,
} from './poller-contract.js';
import type { PrAgentStatus } from './pr-agent-status.js';

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
  tool: ReviewRunTool;
  question?: string;
  /** 入队时间，ISO */
  enqueuedAt: string;
  /** 开始执行时间，ISO；waiting 状态为 null */
  startedAt: string | null;
}

/** 兼容旧引用：active 状态本质就是 startedAt 非空的 PragentRunInfo */
export type ActiveRunInfo = PragentRunInfo;

/** main → renderer 推送事件。renderer 用 window.api.subscribe 监听。 */
export interface IpcEvents {
  'sync:progress': SyncProgressEvent;
  'poll:tick': PollTickEvent;
  'pragent:runProgress': PragentRunProgressEvent;
  /**
   * 草稿变更广播：某 PR 的 drafts.json 发生增/删/改 / /review 完成时的"再摄入"
   * 清理都触发。renderer 据此重拉 drafts 列表 (per localId 过滤)。
   */
  'drafts:changed': { localId: string };
  /** 评论 reply / 状态变更后广播，renderer 各组件 (CommentsPanel / DiffView inline) 重拉 */
  'comments:changed': { localId: string };
  /**
   * 队列变化广播：active 增删 / waiting 增删都触发。renderer 据此同步 chat-pane
   * 运行中 UI + StatusBar 队列 chip。`active` 是当前并发运行中的 run 列表
   * （长度 ≤ max_concurrency）。
   */
  'pragent:queueChanged': {
    active: PragentRunInfo[];
    waiting: PragentRunInfo[];
  };
  /** 启动检测到新版本时推送（仅 hasUpdate=true 时发），renderer 据此提示。 */
  'app:updateAvailable': UpdateCheckResult;
  /** Agent 编排步骤流式推送：每产生一个 AgentStep 即发，renderer 据此实时呈现。 */
  'agent:stepProgress': { sessionId: string; prLocalId: string; step: AgentStep };
}

export type IpcEventName = keyof IpcEvents;

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
  /** 手动检测版本更新（设置页「检查更新」）。仅检测 + 返回结果，不下载 / 安装。 */
  'app:checkUpdate': { request: void; response: UpdateCheckResult };
  /**
   * 渲染层日志回传：把渲染进程的错误 / 未捕获异常转发到 main，落进同一份 meebox.log
   * （renderer 自己的 console 不进文件）。preload 装 window.onerror / unhandledrejection
   * 调用。`scope` 固定 'renderer'，`meta` 任意结构化上下文（如 stack / url）。
   */
  'log:write': {
    request: {
      level: 'error' | 'warn' | 'info' | 'debug';
      msg: string;
      meta?: Record<string, unknown>;
    };
    response: void;
  };
  /**
   * 用系统默认浏览器打开 URL (shell.openExternal)。评论 markdown 内链点击 → 强制
   * 外部打开，避免 Electron 在 app window 内跳转覆盖整个界面
   */
  'app:openExternal': { request: { url: string }; response: void };
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
    // avatarUrl 可选：平台返回的头像直链（GitHub 机器人必须靠它）；缺省时 main 按 slug 推导
    request: { connectionId: string; slug: string; avatarUrl?: string };
    response: { dataUrl: string } | null;
  };
  /**
   * 拉评论 body 内嵌图片 (`![alt](url)`)。url 可能是 Bitbucket attachment 绝对/相对地址，
   * 私有实例需要带 PAT 才能取 → renderer `<img>` 标签无法直接 fetch，必须走 main 代理。
   * 返回 data URL 给 renderer 拼到 `<img src>`；获取失败 (404 / 跨 host / 非图片) 返回 null
   */
  'comments:fetchAttachment': {
    request: { localId: string; url: string };
    response: { dataUrl: string } | null;
  };
  /**
   * 对已有评论发回复。提交成功后 main 端会刷新 comments cache + broadcast
   * comments:changed 事件，renderer 各组件重新拉取列表自动展示新 reply
   */
  'comments:reply': {
    request: { localId: string; parentCommentId: string; body: string };
    response: PrComment;
  };
  /**
   * 删除自己作者的远端评论。Bitbucket 要求带 version (乐观锁)，调用方从已有 PrComment
   * 拿；不一致 / 评论已有回复 / 自己不是作者都会失败 (Bitbucket 409/403)。成功后 main
   * 端清空评论缓存 + broadcast comments:changed，UI 自动重拉刷新
   */
  'comments:delete': {
    request: { localId: string; commentId: string; version: number };
    response: void;
  };
  /**
   * 编辑自己作者评论的 body。Bitbucket PUT 同样要 version (乐观锁) — 不一致回 409，
   * 上层应提示"远端已更新，请刷新后重试"并拒绝静默覆盖。Bitbucket 允许编辑带 reply
   * 的评论 (跟 delete 区别)。成功后 main 端清评论缓存 + 广播
   * comments:changed，UI 自动重拉显示新文本
   */
  'comments:edit': {
    request: {
      localId: string;
      commentId: string;
      version: number;
      body: string;
    };
    response: PrComment;
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
  /**
   * 合并 PR 到目标分支（仅对 canMerge=true 的 PR 暴露入口）。成功后远端 PR 转
   * MERGED，调用方应自行刷新列表（下一轮 poll 会软删该 PR）。失败抛错冒泡到 renderer。
   */
  'prs:merge': {
    request: { localId: string };
    response: void;
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
  /**
   * 拉取 PR 上的已有评论（inline + summary 都拉，renderer 自己分）。
   *
   * 默认走 cache + pr_updated_at stale 比对：命中回缓存，stale/miss 拉远端。
   * 但本地 PR.updatedAt 来自 poller 周期性拉，可能滞后 — 远端新增评论后，
   * 本地 updatedAt 不变 → cache 误判命中 → 不刷新。打开 PR 时 renderer 应该
   * 传 force=true 跳过 stale 比对强制远端拉一次，确保 badge 计数 / inline
   * 评论是最新的
   */
  'diff:listComments': {
    request: { localId: string; force?: boolean };
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
  /**
   * 写入 UI 语言到 config.yaml 并**即时生效**：主进程 i18n 立刻 changeLanguage（后续 dialog/
   * 错误文案 + 下次 pragent:run 的响应语言随之），渲染层另行 i18n.changeLanguage 实时切换。
   * 与代理/连接同属热生效项，无需依赖设置页全局保存。
   */
  'config:setLanguage': { request: { language: SupportedLanguage }; response: void };
  /** 写入 LLM Provider 配置到 config.yaml；下次 pragent:run 自动用新值 */
  'config:setLlm': { request: { llm: Config['llm'] }; response: void };
  /** 写入 agent.dir 到 config.yaml；下次 pragent:run 立即生效 (现读规则) */
  'config:setAgent': { request: { agent: Config['agent'] }; response: void };
  /** 翻转 AutoPilot 开关 (agent.autopilot.enabled) 并写 config.yaml；下次 poll tick 生效。 */
  'agent:setAutopilotEnabled': { request: { enabled: boolean }; response: void };
  /** 写入轮询间隔 (秒，60~900 整数) 到 config.yaml，并热替换 poller 定时器，无需重启 */
  'config:setPoller': { request: { interval_seconds: number }; response: void };
  /**
   * 写入网络代理配置到 config.yaml，并**热重建** adapter（REST 经代理即时生效）。
   * pr-agent / git 出口下次操作读最新配置，无需重启。
   */
  'config:setProxy': { request: { proxy: Config['proxy'] }; response: void };
  /** 用给定代理配置试连一个外部地址，验证代理是否可用；不写配置。 */
  'config:testProxy': {
    request: { proxy: Config['proxy'] };
    response: { ok: boolean; reason?: string };
  };
  /**
   * 写入连接列表 + 当前启用连接到 config.yaml，并**热重建** adapter/poller 即时生效
   * （无需重启）。active 那条被轮询，其余仅保留配置。
   */
  'config:setConnections': {
    request: { connections: Config['connections']; active_connection_id: string };
    response: void;
  };
  /** 用草稿 url/token 临时起 adapter ping，保存前测试连接是否可达；不写配置。 */
  'config:testConnection': {
    request: { base_url: string; token: string; kind?: PlatformKind };
    response: PingResult;
  };
  /**
   * 配置过程中自动把连接 + LLM 草稿写入 config.yaml（防丢失），但**不应用到运行时**
   * （不 reconfigure adapter/poller、不更新内存 config）——重启或点底栏「保存」才生效。
   */
  'config:autosaveDraft': {
    request: {
      connections: Config['connections'];
      active_connection_id: string;
      llm: Config['llm'];
    };
    response: void;
  };
  /**
   * 给指定 PR 查 `<agent.dir>/rules` 当前命中的规则 (按 priority desc + path asc 取首条)。
   * 调用方传 tool 区分 /describe / /review (规则可能只对其中一个 tool 生效)。
   * agent.dir 未配置 / 整体禁用 / 无命中 → 返回 null。
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
   * 对指定 PR 跑一次 Agent 评审微流程（describe→review→条件追问→总结）。同步等待，
   * 期间经 agent:stepProgress 推送步骤；返回收尾后的 AgentSession（含 summary /
   * recommendation）。pr-agent 不可用时 reject。
   */
  'agent:run': {
    request: { localId: string };
    response: AgentSession;
  };
  /**
   * 对指定 PR 跑自由规划 Agent（自然语言入口「对话即委派」）。同步等待，步骤经
   * agent:stepProgress 推送；返回收尾会话（summary = Agent 最终回答）。
   */
  'agent:ask': {
    request: { localId: string; question: string };
    response: AgentSession;
  };
  /** 暂停当前 PR 的 Agent 运行（abort）；会话置 paused、保态。 */
  'agent:stop': { request: { localId: string }; response: { ok: boolean } };
  /**
   * 批量读 AutoPilot 台账：返回各 PR 已自动评审的 recommendation（仅 decision=review 且有
   * 建议者）。PR 列表据此显示徽标，无需逐个加载会话。
   */
  'agent:autopilotLedgers': {
    request: { localIds: string[] };
    response: Record<string, AgentRecommendationVerdict>;
  };
  /**
   * 列出指定 PR 的全部草稿 (pending / edited / posted / rejected 都返回，UI 端按
   * status 过滤显示 / 折叠)。
   */
  'drafts:list': {
    request: { localId: string };
    response: ReviewDraft[];
  };
  /**
   * 创建一条草稿。id / createdAt / updatedAt 由 main 端生成，调用方传业务字段即可。
   * 调用约定：origin='finding' 时必须传 source；origin='manual' 时不要传 source。
   * 成功后 main 端广播 `drafts:changed` 事件。
   */
  'drafts:create': {
    request: {
      localId: string;
      draft: Omit<ReviewDraft, 'id' | 'createdAt' | 'updatedAt' | 'prLocalId'>;
    };
    response: ReviewDraft;
  };
  /**
   * 部分更新一条草稿。规则：
   * - 编辑 body 且 status='pending' → 自动转 'edited'
   * - 显式传 status (e.g., 'rejected') → 按传入值覆盖
   * - 找不到 draftId 返回 null (不抛错，UI 静默兜底)
   */
  'drafts:update': {
    request: {
      localId: string;
      draftId: string;
      patch: Partial<Pick<ReviewDraft, 'body' | 'status' | 'posted_remote_id'>>;
    };
    response: ReviewDraft | null;
  };
  /** 删除一条草稿。删 posted 草稿是允许的 (只清本地，远端 comment 不动) */
  'drafts:delete': {
    request: { localId: string; draftId: string };
    response: void;
  };
  /**
   * 批量发布草稿到远端：每条 draft 经 adapter.publishInlineComment 发到 Bitbucket，
   * 成功 → 本地 draft status='posted' + 写 posted_remote_id；失败 → 保持原 status
   * 不变并把错误收集到 results 里。**单条失败不中断后续条目** —— 跟 Bitbucket web UI
   * "Start review" 行为对齐 (那边也是逐条 POST，某条 400 不影响其它)。
   *
   * 一次性发完后 main 会：
   * 1. 广播 `drafts:changed` —— DiffView / FindingCard 重拉草稿换 status chip
   * 2. force-refresh Bitbucket PR 评论 (跳缓存) + 广播 `comments:changed`，让 CommentsPanel
   *    立即看到自己刚发布的评论，不用等下一轮 poller
   *
   * 调用方 (renderer modal) 据 results 显示 "成功 N 失败 M" + 错误明细
   */
  'drafts:publishBatch': {
    request: { localId: string; draftIds: string[] };
    response: {
      results: Array<{
        draftId: string;
        ok: boolean;
        /** 成功时填，跟落库的 draft.posted_remote_id 同值 */
        postedRemoteId?: string;
        /** 失败时填，人读错因 (Bitbucket REST 4xx body 经过 PlatformError 包装) */
        error?: string;
      }>;
    };
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
  /** 清空指定 PR 的全部 run 历史记录（仅该 PR 生效）。返回删除条数。 */
  'pragent:clearRuns': {
    request: { localId: string };
    response: { cleared: number };
  };
  /**
   * 取消一个 run。语义跟 run 当前状态相关：
   * - 跟 active 匹配 → SIGKILL 子进程，落盘 status='cancelled'
   * - 在 waiting 队列里 → 从队列删除，**不**写盘 (从未真正跑过)；触发 pragent:run
   *   原调用方的 Promise reject 让 ChatPane handleRun 走 error 分支
   * - 都不匹配 (已结束 / 不存在) → 静默 no-op (返回 ok:false)
   */
  'pragent:cancel': {
    request: { runId: string };
    response: { ok: boolean };
  };
  /**
   * 查询当前队列快照 (active + waiting)；renderer 启动 / 重连时拉一下，
   * 跟 queueChanged 事件配套兜底。
   */
  'pragent:queue': {
    request: void;
    response: { active: PragentRunInfo[]; waiting: PragentRunInfo[] };
  };
}

export type IpcChannelName = keyof IpcChannels;

export interface IpcBridge {
  invoke<K extends IpcChannelName>(
    channel: K,
    req: IpcChannels[K]['request'],
  ): Promise<IpcChannels[K]['response']>;
  /** 订阅 main → renderer 推送事件，返回取消订阅函数。 */
  subscribe<E extends IpcEventName>(event: E, handler: (data: IpcEvents[E]) => void): () => void;
}
