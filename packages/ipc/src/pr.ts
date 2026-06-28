import type {
  AskVerdict,
  FindingClosure,
  LocalPrStatus,
  PollResult,
  PrActivityEvent,
  PrComment,
  PrCommit,
  PrDiscoveryFilter,
  ReviewDraft,
  StoredPullRequest,
} from '@meebox/shared';
import type { DiffBlameLine, DiffChangedFile, DiffFileContent, DiffSide } from './common.js';

/** PR 操作域：评论 / 列表 / 状态 / 合并 / 镜像 / diff / 草稿。 */
export interface PrChannels {
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
   * 在 PR 上发一条 summary（顶层、不锚到文件）评论。成功后 main 端清评论缓存 + 广播
   * comments:changed，活动 / 评论面板自动重拉，新评论出现在时间线顶部。
   */
  'comments:create': {
    request: { localId: string; body: string };
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
  'prs:list': { request: void; response: StoredPullRequest[] };
  /** 列出已归档（退场）PR：从冷存储读取，供「已关闭」视图浏览（只读）。 */
  'prs:listArchived': { request: void; response: StoredPullRequest[] };
  /**
   * 按 URL 打开当前平台的 PR：解析链接 → 若本地已存在（活跃 / 归档）直接定位；否则远端拉取（鉴权）后
   * 存入归档冷存储再定位。返回其 localId 与所在范围；解析失败 / 无权限 / 不存在抛 AppError 错误码。
   */
  'prs:openByUrl': {
    request: { url: string };
    /** discoveryFilters：活跃 PR 所属发现分类（前端据此落到能展示它的 tab）；归档 PR 为空。 */
    response: {
      localId: string;
      location: 'active' | 'archived';
      discoveryFilters: PrDiscoveryFilter[];
    };
  };
  'prs:refresh': { request: void; response: PollResult };
  /** Poller 最近一次完成时间（ISO 或 null）；启动时初始化用 */
  'prs:lastSync': { request: void; response: { at: string | null } };
  'prs:setLocalStatus': {
    request: { localId: string; status: LocalPrStatus };
    response: StoredPullRequest | null;
  };
  /**
   * 标记 PR 为已读：推进已读水位（当前 head sha + 时间）并清未读标记。用户打开 PR 时调用。
   * 返回带 `unread:false` 的最新 PR（找不到返回 null）。下一轮 poll 不会因旧事件再把它标回未读。
   */
  'prs:markRead': {
    request: { localId: string };
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
  /**
   * 列出变更文件（自动先 sync mirror）。默认 PR baseSha → headSha 的全部变更；
   * 传 base / head（如某 commit 的 `parent..sha`）则列该范围的变更，用于「查看特定 commit」。
   */
  'diff:listChangedFiles': {
    request: { localId: string; base?: string; head?: string };
    response: DiffChangedFile[];
  };
  /**
   * 列出合并到目标分支会产生冲突的文件路径（PR 目标 tip ⟂ 源 head 的 `git merge-tree` 试合并）。
   * 仅 `pr.hasConflict` 为真时才实际跑 merge-tree，否则直接返回空数组（省一次本地试合并）。
   * 试合并失败 / 无法判定时返回空数组（保守不标冲突），文件树据此在对应行标三角警示图标。
   */
  'diff:listConflictFiles': {
    request: { localId: string };
    response: string[];
  };
  /**
   * 读取 base 或 head 一侧某文件的内容（二进制返回 {binary:true}）。默认取 PR base / head 一侧；
   * 传 base / head sha 则按指定范围取（commit 视图：base=parent、head=commit）。
   */
  'diff:getFileContent': {
    request: { localId: string; side: DiffSide; path: string; base?: string; head?: string };
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
   * 拉取 PR 上的评审决断活动事件（approve / needs-work / unapprove / dismiss），带时间戳。
   * 活动时间线把它与评论 / 提交按时间归并。不缓存（量小，量级同 commits）；平台取不到历史
   * 决断（如 GitLab CE 无审批）时返回 []，时间线只展示评论与提交。
   */
  'diff:listActivity': {
    request: { localId: string };
    response: PrActivityEvent[];
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
    request: { localId: string; path: string; base?: string; head?: string };
    response: {
      /** 仅未变更行的 blame（已过滤掉 PR 改动行） */
      lines: DiffBlameLine[];
      /** PR 引入的 head 行号 (added / modified)，用于 blame 列画色带占位 */
      changedLines: number[];
    };
  };
  /** 计算本地所有 repo 镜像的总占用字节数（设置页用） */
  'repo:getTotalSize': { request: void; response: { totalBytes: number } };
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
   * finding 关闭关系（复评 /ask「取代 / 撤销」原 finding 时建立）。独立于草稿，仅作用于 ChatPane
   * finding 卡片的关闭态 + 与复评卡片互链。create/delete 后 main 广播 `findingClosures:changed`。
   */
  'findingClosures:list': {
    request: { localId: string };
    response: FindingClosure[];
  };
  'findingClosures:create': {
    request: {
      localId: string;
      runId: string;
      findingId: string;
      byAskRunId: string;
      verdict: AskVerdict;
    };
    response: FindingClosure;
  };
  'findingClosures:delete': {
    request: { localId: string; runId: string; findingId: string };
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
}
