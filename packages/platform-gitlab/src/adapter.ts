import type {
  ListPendingOptions,
  MergeStatus,
  MergeVeto,
  PingResult,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformUser,
  PrActivityEvent,
  PrComment,
  PrCommentAnchor,
  PrCommit,
  PrDiscoveryFilter,
  PullRequest,
  RepoRef,
  Reviewer,
  ReviewerStatus,
} from '@meebox/shared';
import { GitLabClient, type GitLabClientOptions } from './client.js';

// ---- GitLab REST v4 响应形状（仅取用到的字段）----

interface GlUser {
  id: number;
  username: string;
  name?: string | null;
  avatar_url?: string | null;
  web_url?: string;
}

interface GlDiffRefs {
  base_sha: string;
  head_sha: string;
  start_sha: string;
}

interface GlMr {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description?: string | null;
  state: 'opened' | 'closed' | 'locked' | 'merged';
  draft?: boolean;
  work_in_progress?: boolean;
  web_url: string;
  created_at: string;
  updated_at: string;
  author: GlUser;
  source_branch: string;
  target_branch: string;
  /** head（源分支最新）sha；详情与列表都带 */
  sha?: string;
  reviewers?: GlUser[];
  /** 15.6+ 的丰富可合并枚举；旧实例可能缺，退 merge_status */
  detailed_merge_status?: string;
  merge_status?: 'can_be_merged' | 'cannot_be_merged' | 'unchecked' | 'checking';
  has_conflicts?: boolean;
  /** 仅单 MR 详情带；行内评论 position 与 base/head sha 需要它 */
  diff_refs?: GlDiffRefs | null;
}

interface GlApprovals {
  approved_by?: Array<{ user: GlUser }>;
}

interface GlCommit {
  id: string;
  short_id?: string;
  title?: string;
  message?: string;
  author_name?: string;
  authored_date?: string;
  committer_name?: string;
  committed_date?: string;
  parent_ids?: string[];
  web_url?: string;
}

interface GlPosition {
  base_sha?: string;
  start_sha?: string;
  head_sha?: string;
  old_path?: string;
  new_path?: string;
  old_line?: number | null;
  new_line?: number | null;
  position_type?: string;
}

interface GlNote {
  id: number;
  type?: 'DiffNote' | 'DiscussionNote' | null;
  body: string;
  author: GlUser;
  created_at: string;
  updated_at: string;
  system?: boolean;
  position?: GlPosition | null;
}

interface GlDiscussion {
  id: string;
  notes: GlNote[];
}

interface GlMetadata {
  version: string;
  enterprise?: boolean;
}

interface GlVersion {
  version: string;
}

export interface GitLabAdapterOptions extends GitLabClientOptions {
  /** clone 协议：'pat'（默认）走 HTTPS + 用户名:PAT；'ssh' 走系统 ssh 配置 */
  cloneProtocol?: 'pat' | 'ssh';
}

/**
 * 容错归一 GitLab API base：用户可只填实例地址（`https://gitlab.example.com`）或完整
 * `.../api/v4`；统一补足 `/api/v4`（已带 `/api/vN` 则原样）。免去用户记忆 API 路径。
 */
export function normalizeGitLabApiBase(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  return /\/api\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/api/v4`;
}

export class GitLabAdapter implements PlatformAdapter {
  readonly kind = 'gitlab' as const;
  private readonly client: GitLabClient;
  private readonly token: string;
  private readonly cloneProtocol: 'pat' | 'ssh';
  /** 实例 web/git host（去掉 /api/v4），clone / 附件 / 网页用。 */
  private readonly webBase: string;
  private readonly gitHost: string;
  private cachedUser: PlatformUser | null = null;
  /**
   * MR 审批 API（approve/unapprove）是否可用：自 13.9 起为 Premium/Ultimate，CE / EE-Free 无。
   * ping() 经 /metadata.enterprise 探测；探测前保守按不可用（CE），使 capabilities 默认不暴露审批。
   * 注：enterprise=true 也不绝对保证审批可用（EE-Free 无），故写路径仍会优雅失败并提示。
   */
  private approvalsAvailable = false;

  constructor(opts: GitLabAdapterOptions) {
    const apiBase = normalizeGitLabApiBase(opts.baseUrl);
    this.client = new GitLabClient({ ...opts, baseUrl: apiBase });
    this.token = opts.token;
    this.cloneProtocol = opts.cloneProtocol ?? 'pat';
    const api = new URL(apiBase);
    this.webBase = `${api.protocol}//${api.host}`;
    this.gitHost = api.host;
  }

  /**
   * GitLab 能力：审批二元（approve/unapprove，无 "request changes" → 不含 needsWork），且 Premium 起才有
   * API → 据 edition 降级（CE/EE-Free 空 + UI 灰显）；行内单行评论；无评论乐观锁；合并否决项 full
   * 保真（detailed_merge_status）；发现端点不强限流。「解决线程 / suggestion / 成组提交」概念有、当前未实现。
   */
  capabilities(): PlatformCapabilities {
    const reviewStatuses: ReadonlyArray<ReviewerStatus> = this.approvalsAvailable
      ? ['approved', 'unapproved']
      : [];
    return {
      reviewStatuses,
      inlineComments: true,
      inlineMultiline: false,
      commentOptimisticLock: false,
      // GitLab 评论走标准 CommonMark（单 \n = 软换行/空格），不按 hard-break。
      commentHardBreaks: false,
      mergeVetoFidelity: 'full',
      discoveryRateLimited: false,
      // GitLab MR 列表支持 reviewer_username / author_username / assignee_username 筛选 → 三类分页。
      // 没有 "mentioned" 概念，故不含 mentioned（poller 逐类轮询 + union 打标，renderer 切标签）。
      discoveryFilters: ['review-requested', 'created', 'assigned'],
      resolvableThreads: false,
      suggestions: false,
      reviewGrouping: false,
      // GitLab 无统一活动事件源（CE 无审批、审批系统 note 解析脆弱）→ PR 标签页退化为纯评论视图。
      activityTimeline: false,
    };
  }

  async ping(): Promise<PingResult> {
    const me = await this.client.get<GlUser>('/user');
    this.cachedUser = mapUser(me);
    let serverVersion = 'gitlab';
    try {
      // /metadata（15.2+）带 enterprise 标志，用于 edition 探测。
      const meta = await this.client.get<GlMetadata>('/metadata');
      serverVersion = meta.version;
      this.approvalsAvailable = meta.enterprise === true;
    } catch {
      // /metadata 不可用（旧实例）→ 退 /version，保守置 CE（无审批）。
      this.approvalsAvailable = false;
      try {
        const ver = await this.client.get<GlVersion>('/version');
        serverVersion = ver.version;
      } catch {
        /* /version 也拿不到时保留默认串 */
      }
    }
    return { ok: true, serverVersion, user: this.cachedUser };
  }

  getCurrentUser(): PlatformUser | null {
    return this.cachedUser;
  }

  setCurrentUser(user: PlatformUser | null): void {
    this.cachedUser = user;
  }

  async getCloneUrl(repo: RepoRef): Promise<string> {
    const path = `${repo.projectKey}/${repo.repoSlug}`;
    if (this.cloneProtocol === 'ssh') {
      return `git@${this.gitHost}:${path}.git`;
    }
    const user = this.cachedUser?.name;
    if (!user) {
      throw new Error(
        'cannot construct PAT clone URL: current user unknown — ping() not called or failed',
      );
    }
    const u = new URL(this.webBase);
    u.pathname = `/${path}.git`;
    u.username = user;
    u.password = this.token;
    return u.toString();
  }

  async listPendingPullRequests(opts?: ListPendingOptions): Promise<PullRequest[]> {
    const me = this.cachedUser?.name;
    // scope=all 全局跨项目；按 filter 切换 reviewer/author/assignee 限定（默认待我评审）。
    // 未 ping（无 me）则无法构造 → 空。
    if (!me) return [];
    const items: GlMr[] = [];
    for await (const mr of this.client.paginate<GlMr>(
      '/merge_requests',
      discoveryParams(opts?.filter ?? 'review-requested', me),
    )) {
      items.push(mr);
    }
    // 每条再取详情（diff_refs / detailed_merge_status）+ 审批（approved_by）。单个失败丢弃该条。
    const results = await Promise.allSettled(items.map((mr) => this.loadMr(mr)));
    return results
      .filter((r): r is PromiseFulfilledResult<PullRequest> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  private async loadMr(listItem: GlMr): Promise<PullRequest> {
    const repo = parseProjectPath(listItem.web_url);
    const base = `/projects/${String(listItem.project_id)}/merge_requests/${String(listItem.iid)}`;
    const detail = await this.client.get<GlMr>(base);
    let approvedUsers: GlUser[] = [];
    if (this.approvalsAvailable) {
      try {
        const approvals = await this.client.get<GlApprovals>(`${base}/approvals`);
        approvedUsers = (approvals.approved_by ?? []).map((a) => a.user);
      } catch {
        /* 审批不可用（tier/权限）→ 视作无人 approve */
      }
    }
    return mapMr(detail, repo, buildReviewers(detail, approvedUsers));
  }

  async listPullRequestCommits(repo: RepoRef, prId: string): Promise<PrCommit[]> {
    const out: PrCommit[] = [];
    for await (const c of this.client.paginate<GlCommit>(
      `/projects/${projectId(repo)}/merge_requests/${prId}/commits`,
    )) {
      out.push(mapCommit(c));
    }
    // GitLab MR commits 端点已是 reverse-chronological（newest-first），契约同要求，无需反转。
    return out;
  }

  async listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]> {
    const me = this.cachedUser?.name;
    const out: PrComment[] = [];
    for await (const d of this.client.paginate<GlDiscussion>(
      `/projects/${projectId(repo)}/merge_requests/${prId}/discussions`,
    )) {
      // 过滤 system note（状态变更 / 指派等自动事件）。
      const notes = d.notes.filter((n) => !n.system);
      if (notes.length === 0) continue;
      const [head, ...rest] = notes;
      const top = mapNote(head!, d.id, me);
      top.replies = rest.map((n) => mapNote(n, d.id, me));
      out.push(top);
    }
    return out;
  }

  async listPullRequestActivity(_repo: RepoRef, _prId: string): Promise<PrActivityEvent[]> {
    // 差异化设计：GitLab 不参与活动时间线（capabilities.activityTimeline=false，PR 标签页退化为纯
    // 评论视图），故无需提供决断事件。GitLab 也没有统一活动事件源——CE 无审批、审批仅以脆弱的英文
    // 系统 note 体现，与 Bitbucket /activities、GitHub /reviews 的可靠时间戳事件不对等——返回空。
    return [];
  }

  async getUserAvatar(
    _slug: string,
    avatarUrl?: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    // GitLab 无 <host>/<username>.png 直链；只有 avatar_url 直链时才拉（本实例 host 才带 PAT），
    // 否则退 initials。
    if (avatarUrl) return this.client.getBinary(avatarUrl);
    return null;
  }

  async getAttachment(
    url: string,
    repo?: RepoRef,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    // 项目 markdown 上传 `/uploads/<secret>/<file>`（绝对或相对皆可）：其 web 路由对 PAT 一律 302
    // 到登录页（私有项目仅认浏览器 session），故改走 API 下载端点 `GET /projects/:id/uploads/
    // :secret/:filename`（GitLab 17.4+ 认 PRIVATE-TOKEN；旧版无此路由 → 404 → null）。
    const isRelative = !/^https?:\/\//.test(url);
    let sameHost = isRelative;
    if (!isRelative) {
      try {
        sameHost = new URL(url).host === this.gitHost;
      } catch {
        sameHost = false;
      }
    }
    const m = url.match(/\/uploads\/([0-9a-f]+)\/([^/?#]+)/i);
    if (m && repo && sameHost) {
      const [, secret, filename] = m;
      return this.client.getApiBinary(
        `/projects/${projectId(repo)}/uploads/${secret}/${filename}`,
      );
    }
    // 其它本实例绝对 URL（非 /uploads 的图）仍直接代理；非本实例 / 解析不出 → null 让上层 fallback。
    if (/^https?:\/\//.test(url)) return this.client.getBinary(url);
    return null;
  }

  async publishSummaryComment(repo: RepoRef, prId: string, body: string): Promise<PrComment> {
    // summary 评论 = 不带 position 的新 discussion（顶层 note）
    const created = await this.client.post<GlDiscussion>(
      `/projects/${projectId(repo)}/merge_requests/${prId}/discussions`,
      { body },
    );
    return mapNote(created.notes[0]!, created.id, this.cachedUser?.name);
  }

  async publishInlineComment(
    repo: RepoRef,
    prId: string,
    anchor: PrCommentAnchor,
    body: string,
  ): Promise<PrComment> {
    const base = `/projects/${projectId(repo)}/merge_requests/${prId}`;
    // 行内评论 = 带 position 的 discussion；position 需 base/start/head 三 sha → 先拉 MR 取 diff_refs。
    const mr = await this.client.get<GlMr>(base);
    const refs = mr.diff_refs;
    if (!refs) {
      throw new Error('无法发布行内评论：该 MR 缺少 diff_refs（diff 可能尚未生成）');
    }
    const position: Record<string, unknown> = {
      base_sha: refs.base_sha,
      start_sha: refs.start_sha,
      head_sha: refs.head_sha,
      position_type: 'text',
      new_path: anchor.path,
      old_path: anchor.path,
    };
    // side 'new'（added/context）锚到 new_line；'old'（removed）锚到 old_line。
    if (anchor.side === 'new') position.new_line = anchor.line;
    else position.old_line = anchor.line;
    const created = await this.client.post<GlDiscussion>(`${base}/discussions`, { body, position });
    return mapNote(created.notes[0]!, created.id, this.cachedUser?.name);
  }

  async replyToComment(
    repo: RepoRef,
    prId: string,
    parentCommentId: string,
    body: string,
  ): Promise<PrComment> {
    // parentCommentId = discussion_id（threadId）；renderer 已改为传 threadId ?? remoteId。
    const note = await this.client.post<GlNote>(
      `/projects/${projectId(repo)}/merge_requests/${prId}/discussions/${parentCommentId}/notes`,
      { body },
    );
    return mapNote(note, parentCommentId, this.cachedUser?.name);
  }

  async editComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    _version: number,
    body: string,
  ): Promise<PrComment> {
    // GitLab 无评论乐观锁（version 忽略）；/notes/:id 覆盖 discussion 内 note。
    const note = await this.client.put<GlNote>(
      `/projects/${projectId(repo)}/merge_requests/${prId}/notes/${commentId}`,
      { body },
    );
    if (!note) throw new Error('编辑评论失败：远端空响应');
    // 编辑响应不带 discussion id，threadId 用 note id 兜底（UI 删改后会 force-refresh 评论树）。
    return mapNote(note, String(note.id), this.cachedUser?.name);
  }

  async deleteComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    _version: number,
  ): Promise<void> {
    await this.client.del(
      `/projects/${projectId(repo)}/merge_requests/${prId}/notes/${commentId}`,
    );
  }

  async setPullRequestReviewStatus(
    repo: RepoRef,
    prId: string,
    status: ReviewerStatus,
  ): Promise<void> {
    const base = `/projects/${projectId(repo)}/merge_requests/${prId}`;
    if (status === 'approved') {
      await this.client.post(`${base}/approve`, {});
      return;
    }
    if (status === 'unapproved') {
      await this.client.post(`${base}/unapprove`, {});
      return;
    }
    // needsWork：GitLab 无 "request changes" 概念。capabilities.reviewStatuses 不含 needsWork，
    // UI 不会触发；防御性抛错。
    throw new Error('GitLab 不支持「需修改」审批状态');
  }

  async mergePullRequest(repo: RepoRef, prId: string): Promise<void> {
    // PUT /merge：squash/ff 由仓库设置决定。失败（冲突 / 未批 / 流水线未过 / 权限）→ 405/406/409 带 message。
    await this.client.put(`/projects/${projectId(repo)}/merge_requests/${prId}/merge`, {});
  }
}

// ---- 辅助与映射函数 ----

/** GitLab 端点 `:id`：RepoRef 的 `projectKey/repoSlug`（含嵌套 group）URL-encode 成单段路径。 */
function projectId(repo: RepoRef): string {
  return encodeURIComponent(`${repo.projectKey}/${repo.repoSlug}`);
}

/** 发现分类 → /merge_requests 查询参数（scope=all 全局，按角色限定）。mentioned 无对应 → 退待我评审。 */
function discoveryParams(filter: PrDiscoveryFilter, me: string): Record<string, string> {
  const base = { scope: 'all', state: 'opened' };
  switch (filter) {
    case 'created':
      return { ...base, author_username: me };
    case 'assigned':
      return { ...base, assignee_username: me };
    case 'review-requested':
    case 'mentioned':
    default:
      return { ...base, reviewer_username: me };
  }
}

/**
 * 从 MR web_url 解析项目路径：`https://host/<group>/<sub>/<project>/-/merge_requests/<iid>`
 * → projectKey=`group/sub`（嵌套 namespace），repoSlug=`project`。
 */
function parseProjectPath(webUrl: string): RepoRef {
  let pathname: string;
  try {
    pathname = new URL(webUrl).pathname;
  } catch {
    pathname = webUrl;
  }
  const idx = pathname.indexOf('/-/');
  const full = (idx >= 0 ? pathname.slice(0, idx) : pathname).replace(/^\/+|\/+$/g, '');
  const segs = full.split('/');
  const repoSlug = segs.pop() ?? '';
  return { projectKey: segs.join('/'), repoSlug };
}

function mapUser(u: GlUser): PlatformUser {
  return {
    name: u.username,
    displayName: u.name ?? u.username,
    slug: u.username,
    avatarUrl: u.avatar_url ?? undefined,
  };
}

function mergeStatusReason(dms: string): string {
  switch (dms) {
    case 'broken_status':
    case 'conflict':
      return '存在合并冲突';
    case 'draft_status':
      return '草稿状态，需标记为可合并';
    case 'discussions_not_resolved':
      return '存在未解决的讨论';
    case 'ci_must_pass':
    case 'ci_still_running':
      return '流水线未通过 / 进行中';
    case 'not_approved':
    case 'requested_changes':
      return '审批未满足要求';
    case 'need_rebase':
      return '需先 rebase 目标分支';
    case 'not_open':
      return 'MR 非打开状态';
    case 'blocked_status':
      return '被其它 MR 阻塞';
    case 'preparing':
    case 'checking':
    case 'unchecked':
      return '可合并状态计算中…';
    default:
      return `暂不可合并（${dms}）`;
  }
}

function mapMergeStatus(mr: GlMr): MergeStatus {
  const dms = mr.detailed_merge_status;
  const conflicted =
    mr.has_conflicts === true || dms === 'broken_status' || dms === 'conflict';
  const vetoes: MergeVeto[] = [];
  let canMerge: boolean;
  if (dms) {
    canMerge = dms === 'mergeable';
    if (!canMerge) vetoes.push({ summary: mergeStatusReason(dms) });
  } else {
    // 旧实例无 detailed_merge_status：退 merge_status。
    canMerge = mr.merge_status === 'can_be_merged' && !conflicted;
    if (conflicted) vetoes.push({ summary: '存在合并冲突' });
    else if (mr.merge_status === 'cannot_be_merged')
      vetoes.push({ summary: '远端判定当前不可合并' });
    else if (mr.merge_status === 'checking' || mr.merge_status === 'unchecked')
      vetoes.push({ summary: '可合并状态计算中…' });
  }
  return { canMerge, conflicted, vetoes };
}

function buildReviewers(mr: GlMr, approvedUsers: GlUser[]): Reviewer[] {
  const byUser = new Map<string, Reviewer>();
  // 先放指派的 reviewer（默认未批）。
  for (const u of mr.reviewers ?? []) {
    byUser.set(u.username, { ...mapUser(u), status: 'unapproved' });
  }
  // approved_by 覆盖 / 补充为 approved（含未在 reviewers 列表但已批的人）。
  for (const u of approvedUsers) {
    byUser.set(u.username, { ...mapUser(u), status: 'approved' });
  }
  return [...byUser.values()];
}

function mapMr(mr: GlMr, repo: RepoRef, reviewers: Reviewer[]): PullRequest {
  const state: PullRequest['state'] =
    mr.state === 'merged' ? 'merged' : mr.state === 'opened' ? 'open' : 'declined';
  const mergeStatus = mapMergeStatus(mr);
  return {
    remoteId: String(mr.iid),
    title: mr.title,
    description: mr.description ?? '',
    author: mapUser(mr.author),
    state,
    draft: mr.draft ?? mr.work_in_progress ?? false,
    sourceRef: { displayId: mr.source_branch, sha: mr.diff_refs?.head_sha ?? mr.sha ?? '' },
    targetRef: { displayId: mr.target_branch, sha: mr.diff_refs?.base_sha ?? '' },
    repo,
    url: mr.web_url,
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    reviewers,
    mergeStatus,
    hasConflict: mergeStatus.conflicted,
  };
}

function mapCommit(c: GlCommit): PrCommit {
  const authorName = c.author_name ?? 'unknown';
  const committerName = c.committer_name ?? authorName;
  return {
    sha: c.id,
    abbreviatedSha: c.short_id ?? c.id.slice(0, 8),
    message: c.message ?? c.title ?? '',
    author: { name: authorName, displayName: authorName },
    authoredAt: c.authored_date ?? '',
    committer: { name: committerName, displayName: committerName },
    committedAt: c.committed_date ?? c.authored_date ?? '',
    parents: c.parent_ids ?? [],
    url: c.web_url,
  };
}

function mapNote(n: GlNote, discussionId: string, me: string | undefined): PrComment {
  const pos = n.position;
  const anchor: PrCommentAnchor | null =
    pos && pos.position_type === 'text' && (pos.new_line != null || pos.old_line != null)
      ? {
          path: pos.new_path ?? pos.old_path ?? '',
          line: pos.new_line ?? pos.old_line ?? 0,
          side: pos.new_line != null ? 'new' : 'old',
          // new_line + old_line 同在 = context；仅 new = added；仅 old = removed。
          lineType:
            pos.new_line != null
              ? pos.old_line != null
                ? 'context'
                : 'added'
              : 'removed',
        }
      : null;
  const isMine = me != null && n.author.username === me;
  return {
    remoteId: String(n.id),
    author: mapUser(n.author),
    body: n.body,
    createdAt: n.created_at,
    updatedAt: n.updated_at,
    anchor,
    replies: [],
    kind: anchor ? 'inline' : 'summary',
    threadId: discussionId,
    nativeId: String(n.id),
    canDelete: isMine,
    canEdit: isMine,
    // GitLab 无乐观锁：置 0 作「无需并发令牌」哨兵，让 canEdit/canDelete 判定与编辑/删除 IPC
    // 的 version: number 契约统一通过（editComment/deleteComment 忽略 version）。
    version: 0,
  };
}
