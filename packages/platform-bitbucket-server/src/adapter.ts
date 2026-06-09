import type {
  ListPendingOptions,
  MergeStatus,
  PingResult,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformUser,
  PrComment,
  PrCommentAnchor,
  PrCommit,
  PullRequest,
  RepoRef,
  Reviewer,
  ReviewerStatus,
} from '@meebox/shared';
import { BitbucketClient, type BitbucketClientOptions } from './client.js';

interface BitbucketUser {
  name: string;
  displayName: string;
  emailAddress?: string;
  active: boolean;
  slug: string;
}

interface BitbucketRef {
  id: string;
  displayId: string;
  latestCommit: string;
  type: 'BRANCH' | 'TAG';
  repository: {
    slug: string;
    name: string;
    project: { key: string; name: string };
  };
}

interface BitbucketParticipant {
  user: BitbucketUser;
  role: 'AUTHOR' | 'REVIEWER' | 'PARTICIPANT';
  approved: boolean;
  status?: 'UNAPPROVED' | 'APPROVED' | 'NEEDS_WORK';
}

interface BitbucketPullRequest {
  id: number;
  version: number;
  title: string;
  description?: string;
  state: 'OPEN' | 'MERGED' | 'DECLINED';
  open: boolean;
  closed: boolean;
  draft?: boolean;
  createdDate: number;
  updatedDate: number;
  fromRef: BitbucketRef;
  toRef: BitbucketRef;
  author: BitbucketParticipant;
  reviewers: BitbucketParticipant[];
  links: { self: Array<{ href: string }> };
}

interface BitbucketApplicationProperties {
  version: string;
  buildNumber: string;
  displayName: string;
}

interface BitbucketMergeStatus {
  canMerge: boolean;
  conflicted: boolean;
  outcome: 'CLEAN' | 'CONFLICTED' | 'CONFLICTED_AND_AHEAD' | string;
  vetoes?: Array<{ summaryMessage: string; detailedMessage?: string }>;
}

interface BitbucketComment {
  id: number;
  version: number;
  text: string;
  author: BitbucketUser;
  createdDate: number;
  updatedDate: number;
  comments?: BitbucketComment[];
  parent?: { id: number };
}

interface BitbucketCommentAnchor {
  diffType?: 'EFFECTIVE' | 'COMMIT' | 'RANGE';
  // line / lineType 对文件级评论（挂在文件而非具体行）或孤儿 anchor（锚定行已不存在）
  // 可能缺省 —— 标可选，mapBBAnchor 据此降级，避免读 undefined.toLowerCase 崩
  line?: number;
  lineType?: 'ADDED' | 'REMOVED' | 'CONTEXT';
  fileType?: 'FROM' | 'TO';
  path: string;
  srcPath?: string;
}

interface BitbucketCommit {
  id: string;            // 40-char SHA
  displayId: string;     // 短 SHA (Bitbucket 默认 7-12 chars)
  message: string;       // 完整 commit message
  author: { name: string; emailAddress?: string };
  authorTimestamp: number;          // epoch ms
  committer: { name: string; emailAddress?: string };
  committerTimestamp: number;       // epoch ms
  parents: Array<{ id: string; displayId: string }>;
}

interface BitbucketActivity {
  id: number;
  createdDate: number;
  user: BitbucketUser;
  action: string;
  commentAction?: 'ADDED' | 'UPDATED' | 'DELETED' | 'REPLIED';
  comment?: BitbucketComment;
  commentAnchor?: BitbucketCommentAnchor;
}

const MIN_VERSION: readonly [number, number, number] = [7, 0, 0];

export interface BitbucketServerAdapterOptions extends BitbucketClientOptions {
  /** clone 协议：'pat'（默认）走 HTTPS+用户名:PAT；'ssh' 走系统 ssh 配置 */
  cloneProtocol?: 'pat' | 'ssh';
}

export class BitbucketServerAdapter implements PlatformAdapter {
  readonly kind = 'bitbucket-server' as const;
  private readonly client: BitbucketClient;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly cloneProtocol: 'pat' | 'ssh';
  private cachedUser: PlatformUser | null = null;

  constructor(opts: BitbucketServerAdapterOptions) {
    this.client = new BitbucketClient(opts);
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.cloneProtocol = opts.cloneProtocol ?? 'pat';
  }

  /**
   * Bitbucket Server 能力：三态审批、行内多行评论、删改乐观锁、否决项逐条（/merge vetoes）。
   * 无「解决线程 / 代码 suggestion / pending-review 成组」概念；dashboard 发现不强限流。
   */
  capabilities(): PlatformCapabilities {
    return {
      reviewStatuses: ['approved', 'needsWork', 'unapproved'],
      inlineComments: true,
      inlineMultiline: true,
      commentOptimisticLock: true,
      mergeVetoFidelity: 'full',
      discoveryRateLimited: false,
      // Bitbucket dashboard 支持 role=REVIEWER/AUTHOR → 提供「待我评审 / 我创建的」两类
      discoveryFilters: ['review-requested', 'created'],
      resolvableThreads: false,
      suggestions: false,
      reviewGrouping: false,
    };
  }

  /**
   * 返回 clone URL，行为按 cloneProtocol 切分：
   *
   * **pat（默认）**: `https://<当前用户名>:<PAT>@<host>/scm/<proj>/<repo>.git`
   * - Bitbucket Server 的 PAT 鉴权要求真实用户名 (X-AUSERNAME) 作为 username，
   *   PAT 作为 password（不是 Bitbucket Cloud 的 x-token-auth）
   * - 调用前必须先 ping() 让 cachedUser 落地，否则抛
   * - 风险提示：PAT 在 URL 里会出现在 git reflog / 进程命令行，敏感场景请用 ssh
   *
   * **ssh**: `git@<host>:<proj>/<repo>.git` (scp-like)
   * - 端口 / 私钥 / username 完全由系统 `~/.ssh/config` 负责
   * - Bitbucket Server 默认 SSH 端口 7999，需在 ssh config 里给 host 配 Port
   */
  async getCloneUrl(repo: RepoRef): Promise<string> {
    const u = new URL(this.baseUrl);
    if (this.cloneProtocol === 'ssh') {
      return `git@${u.hostname}:${repo.projectKey}/${repo.repoSlug}.git`;
    }
    // pat 模式
    const user = this.cachedUser?.name;
    if (!user) {
      throw new Error(
        'cannot construct PAT clone URL: current user unknown — ping() not called or failed',
      );
    }
    u.pathname = `/scm/${repo.projectKey}/${repo.repoSlug}.git`;
    u.username = user;
    u.password = this.token;
    return u.toString();
  }

  async ping(): Promise<PingResult> {
    const { body: props, headers } = await this.client.getWithHeaders<BitbucketApplicationProperties>(
      '/rest/api/1.0/application-properties',
    );

    // 当前用户从响应头 X-AUSERNAME (slug) 拿，再查 /users/{slug} 拿 displayName
    const slug = headers.get('x-ausername');
    if (slug) {
      try {
        const u = await this.client.get<BitbucketUser>(
          `/rest/api/1.0/users/${encodeURIComponent(slug)}`,
        );
        this.cachedUser = { name: u.name, displayName: u.displayName, slug: u.slug };
      } catch {
        // /users/{slug} 失败时退而求其次，slug 当 displayName
        this.cachedUser = { name: slug, displayName: slug, slug };
      }
    }

    const cmp = compareVersion(props.version, MIN_VERSION);
    if (cmp >= 0) {
      return { ok: true, serverVersion: props.version, user: this.cachedUser ?? undefined };
    }
    return {
      ok: false,
      serverVersion: props.version,
      user: this.cachedUser ?? undefined,
      reason: `未支持的 Bitbucket Server 版本：${props.version}；最低要求 ${MIN_VERSION.join('.')}`,
    };
  }

  getCurrentUser(): PlatformUser | null {
    return this.cachedUser;
  }

  async listPendingPullRequests(opts?: ListPendingOptions): Promise<PullRequest[]> {
    // 发现分类 → dashboard role：created=我创建(AUTHOR)，其余(待我评审)=REVIEWER。
    const role = opts?.filter === 'created' ? 'AUTHOR' : 'REVIEWER';
    const bitbucketPrs: BitbucketPullRequest[] = [];
    for await (const pr of this.client.paginate<BitbucketPullRequest>(
      '/rest/api/1.0/dashboard/pull-requests',
      { role, state: 'OPEN' },
    )) {
      bitbucketPrs.push(pr);
    }

    // N+1：并行抓每个 PR 的 /merge 状态拿 canMerge / conflicted / vetoes（同源一次拉全）。
    // 单个失败降级到"无已知阻塞"（canMerge=true / 无冲突 / 无 vetoes）—— 跟原 hasConflict
    // 失败降级语义一致，保守不误标。
    const mergeResults = await Promise.allSettled(
      bitbucketPrs.map((pr) => this.fetchMergeStatus(pr)),
    );

    return bitbucketPrs.map((pr, i) => {
      const result = mergeResults[i]!;
      const mergeStatus =
        result.status === 'fulfilled'
          ? mapMergeStatus(result.value)
          : { canMerge: true, conflicted: false, vetoes: [] };
      return mapPullRequest(pr, mergeStatus);
    });
  }

  private async fetchMergeStatus(pr: BitbucketPullRequest): Promise<BitbucketMergeStatus> {
    const project = pr.toRef.repository.project.key;
    const repo = pr.toRef.repository.slug;
    return this.client.get<BitbucketMergeStatus>(
      `/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests/${String(pr.id)}/merge`,
    );
  }

  async getAttachment(
    url: string,
    repo?: RepoRef,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    // host 解析 + Bitbucket attachment: 协议处理 + PAT 鉴权拉取都在 BitbucketClient 里完成，
    // adapter 只是 thin wrapper
    return this.client.getAttachmentBinary(url, repo);
  }

  async replyToComment(
    repo: RepoRef,
    prId: string,
    parentCommentId: string,
    body: string,
  ): Promise<PrComment> {
    // Bitbucket REST: POST /pull-requests/{id}/comments
    //   body 内 text + parent.id → 作为已有评论的 reply
    //   不带 anchor — reply 继承父评论的 anchor (inline 跟 summary 行为一致)
    const created = await this.client.post<BitbucketComment>(
      `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/comments`,
      { text: body, parent: { id: Number(parentCommentId) } },
    );
    return mapBBComment(created);
  }

  async deleteComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    version: number,
  ): Promise<void> {
    // Bitbucket REST: DELETE /pull-requests/{id}/comments/{cid}?version={v}
    // - version 必填 (乐观锁)，不一致回 409 + 描述 "expected version X"
    // - 已有 reply / 自己不是作者 / 评论已删 都回 409 或 403，错误体 client 已带回
    // - 成功 204 No Content
    await this.client.del(
      `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/comments/${commentId}?version=${String(version)}`,
    );
  }

  async editComment(
    repo: RepoRef,
    prId: string,
    commentId: string,
    version: number,
    body: string,
  ): Promise<PrComment> {
    // Bitbucket REST: PUT /pull-requests/{id}/comments/{cid}
    //   payload {text, version}
    // - version 不一致回 409；自己不是作者回 403；空 body 回 400
    // - 成功 200 返回更新后的 BitbucketComment (含 version+1 + 新 updatedDate)
    const updated = await this.client.put<BitbucketComment>(
      `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/comments/${commentId}`,
      { text: body, version },
    );
    if (!updated) {
      // PUT 接口正常返回 JSON；走到这里只可能是上游 Bitbucket 配错回了 204
      throw new Error('editComment: Bitbucket 返回空响应，无法确认更新结果');
    }
    return mapBBComment(updated);
  }

  async publishInlineComment(
    repo: RepoRef,
    prId: string,
    anchor: PrCommentAnchor,
    body: string,
  ): Promise<PrComment> {
    // Bitbucket REST: POST /pull-requests/{id}/comments
    //   {text, anchor:{path, line, lineType, fileType, srcPath?, diffType?}}
    // - line + lineType + fileType 三元组必须跟该行在 diff 里的真实角色一致
    //   (added 行只能 lineType=ADDED + fileType=TO；removed 行只能 REMOVED+FROM；
    //   context 行可 CONTEXT+TO/FROM 任一)。对不上 Bitbucket 回 400 'invalid anchor'
    // - diffType=EFFECTIVE 是 Bitbucket web UI 默认值，等价 'against effective diff'，
    //   不带 Bitbucket 会按 RANGE 兜底 (against latest commit)，PR 接 force-push 后会失锚
    const created = await this.client.post<BitbucketComment>(
      `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/comments`,
      { text: body, anchor: toBBAnchor(anchor) },
    );
    return mapBBComment(created);
  }

  async getUserAvatar(
    slug: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    // Bitbucket user slug 总是小写；comments / activities 端点的 author 经常带回大小写
    // 混合的 name (如 "Avery.Lee") 而不附 slug 字段，调用方退回 name 时大小写
    // 不一致会 404。先按原值试，失败再小写一次。
    const candidates =
      slug !== slug.toLowerCase() ? [slug, slug.toLowerCase()] : [slug];
    for (const s of candidates) {
      try {
        return await this.client.getBinary(`/users/${encodeURIComponent(s)}/avatar.png`, {
          s: '64',
        });
      } catch {
        // 试下一个
      }
    }
    return null;
  }

  /**
   * 把当前 PAT 用户在 PR 上的 review 状态写到 Bitbucket。底层走
   * `PUT /pull-requests/{id}/participants/{userSlug}`，body 携带 status + user.name。
   *
   * - status: 'approved' → Bitbucket 'APPROVED'；'needsWork' → 'NEEDS_WORK'；
   *   'unapproved' → 'UNAPPROVED'（撤销之前的标记，回到 pending）
   * - 必须 ping() 已经跑过且 cachedUser 落地；否则抛
   */
  async setPullRequestReviewStatus(
    repo: RepoRef,
    prId: string,
    status: ReviewerStatus,
  ): Promise<void> {
    const me = this.cachedUser;
    if (!me) {
      throw new Error(
        'setPullRequestReviewStatus: current user unknown — ping() not called or failed',
      );
    }
    const slug = me.slug ?? me.name;
    const bitbucketStatus =
      status === 'approved' ? 'APPROVED' : status === 'needsWork' ? 'NEEDS_WORK' : 'UNAPPROVED';
    await this.client.put(
      `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/participants/${encodeURIComponent(slug)}`,
      { status: bitbucketStatus, user: { name: me.name } },
    );
  }

  async mergePullRequest(repo: RepoRef, prId: string): Promise<void> {
    const base = `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}`;
    // 合并需要当前 PR version (乐观锁)；先拉最新 PR 拿 version，避免缓存旧值触发 409
    const pr = await this.client.get<BitbucketPullRequest>(base);
    // POST .../merge?version=N；body 留空。冲突 / veto 未通过 / 无权限 → Bitbucket 回 409/403，
    // client 抛错冒泡给上层
    await this.client.post(`${base}/merge?version=${String(pr.version)}`, {});
  }

  /**
   * 列出 PR commits。Bitbucket endpoint：
   *   GET /rest/api/1.0/projects/{p}/repos/{r}/pull-requests/{id}/commits
   *
   * 默认 newest first (跟 git log 一致)；Bitbucket 分页接口我们已有 paginate iterator，
   * 一次性收集全部。规模考虑：PR 通常几十个 commit，不分页问题不大。
   */
  async listPullRequestCommits(repo: RepoRef, prId: string): Promise<PrCommit[]> {
    const out: PrCommit[] = [];
    for await (const c of this.client.paginate<BitbucketCommit>(
      `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/commits`,
    )) {
      out.push(mapBBCommit(c, this.baseUrl, repo));
    }
    return out;
  }

  async listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]> {
    // Bitbucket 走 /activities 拿全部活动，过滤 COMMENTED + ADDED（top-level + 回复）。
    // - 跳过 DELETED / UPDATED 派生事件
    // - 跳过 reply（有 parent 字段），它们会跟着父评论的 .comments 一起出来
    // - 用 id 去重，防同一条评论多次出现
    const seen = new Set<string>();
    const out: PrComment[] = [];
    for await (const activity of this.client.paginate<BitbucketActivity>(
      `/rest/api/1.0/projects/${repo.projectKey}/repos/${repo.repoSlug}/pull-requests/${prId}/activities`,
    )) {
      if (activity.action !== 'COMMENTED') continue;
      if (activity.commentAction !== 'ADDED') continue;
      const c = activity.comment;
      if (!c) continue;
      if (c.parent) continue;
      const id = String(c.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(mapBBComment(c, activity.commentAnchor));
    }
    return out;
  }
}

function mapBBCommit(c: BitbucketCommit, baseUrl: string, repo: RepoRef): PrCommit {
  // Bitbucket commit URL：/projects/<p>/repos/<r>/commits/<sha>
  const url = `${baseUrl}/projects/${repo.projectKey}/repos/${repo.repoSlug}/commits/${c.id}`;
  return {
    sha: c.id,
    abbreviatedSha: c.displayId,
    message: c.message,
    author: bitbucketCommitterToUser(c.author),
    authoredAt: new Date(c.authorTimestamp).toISOString(),
    committer: bitbucketCommitterToUser(c.committer),
    committedAt: new Date(c.committerTimestamp).toISOString(),
    parents: c.parents.map((p) => p.id),
    url,
  };
}

/**
 * Bitbucket commit 的 author/committer 只给 name (含 email)，没有 slug / displayName，
 * 跟 PlatformUser 字段对不齐。这里把 name 同时当 name + displayName 用，slug 留空。
 * UI 头像会 fallback 到 initials；email 字段我们当前 PlatformUser 没存，先丢弃。
 */
function bitbucketCommitterToUser(c: { name: string; emailAddress?: string }): PlatformUser {
  return { name: c.name, displayName: c.name };
}

function mapBBComment(c: BitbucketComment, anchor?: BitbucketCommentAnchor): PrComment {
  return {
    remoteId: String(c.id),
    author: mapUser(c.author),
    body: c.text,
    createdAt: new Date(c.createdDate).toISOString(),
    updatedAt: new Date(c.updatedDate).toISOString(),
    anchor: anchor ? mapBBAnchor(anchor) : null,
    replies: (c.comments ?? []).map((r) => mapBBComment(r)),
    // 透传 Bitbucket 乐观锁版本号 — DELETE / PUT 时调用方必须带回来，否则 409
    version: c.version,
  };
}

function mapBBAnchor(a: BitbucketCommentAnchor): PrCommentAnchor | null {
  // 无行号 = 文件级 / 孤儿 anchor，无法锚到具体行 → 返回 null，调用方退化成 summary 评论
  if (a.line == null) return null;
  return {
    path: a.path,
    line: a.line,
    side: a.fileType === 'FROM' ? 'old' : 'new',
    // lineType 偶有缺省 → 兜底 'context'（最保守值，跟发布 anchor 的兜底一致）
    lineType: (a.lineType?.toLowerCase() ?? 'context') as PrCommentAnchor['lineType'],
  };
}

/**
 * 跨平台中性 anchor → Bitbucket REST 字段。mapBBAnchor 的反方向，发布 inline 评论时
 * 用。diffType 显式给 'EFFECTIVE' 让评论锚到"当前生效 diff"而不是某次具体 commit
 * —— PR 后续 push 新 commit 时评论仍跟着行走。
 */
function toBBAnchor(a: PrCommentAnchor): BitbucketCommentAnchor {
  return {
    diffType: 'EFFECTIVE',
    path: a.path,
    line: a.line,
    lineType: a.lineType.toUpperCase() as BitbucketCommentAnchor['lineType'],
    fileType: a.side === 'old' ? 'FROM' : 'TO',
  };
}

function mapUser(u: BitbucketUser): PlatformUser {
  return { name: u.name, displayName: u.displayName, slug: u.slug };
}

function mapReviewer(p: BitbucketParticipant): Reviewer {
  // status 是 Bitbucket 7.x+ 才有的字段；缺失时退回 approved 布尔
  let status: ReviewerStatus;
  if (p.status === 'APPROVED') status = 'approved';
  else if (p.status === 'NEEDS_WORK') status = 'needsWork';
  else if (p.status === 'UNAPPROVED') status = 'unapproved';
  else status = p.approved ? 'approved' : 'unapproved';
  return { ...mapUser(p.user), status };
}

/** Bitbucket `/merge` 响应 → 中性 MergeStatus。vetoes 缺省时归一成空数组。 */
function mapMergeStatus(bb: BitbucketMergeStatus): MergeStatus {
  return {
    canMerge: bb.canMerge,
    conflicted: bb.conflicted,
    vetoes: (bb.vetoes ?? []).map((v) => ({
      summary: v.summaryMessage,
      detail: v.detailedMessage,
    })),
  };
}

function mapPullRequest(bb: BitbucketPullRequest, mergeStatus: MergeStatus): PullRequest {
  const url = bb.links.self[0]?.href ?? '';
  const targetRepo = bb.toRef.repository;
  return {
    remoteId: String(bb.id),
    title: bb.title,
    description: bb.description ?? '',
    author: mapUser(bb.author.user),
    state: bb.state.toLowerCase() as PullRequest['state'],
    draft: bb.draft ?? false,
    sourceRef: { displayId: bb.fromRef.displayId, sha: bb.fromRef.latestCommit },
    targetRef: { displayId: bb.toRef.displayId, sha: bb.toRef.latestCommit },
    repo: { projectKey: targetRepo.project.key, repoSlug: targetRepo.slug },
    url,
    createdAt: new Date(bb.createdDate).toISOString(),
    updatedAt: new Date(bb.updatedDate).toISOString(),
    reviewers: bb.reviewers.map((r) => mapReviewer(r)),
    mergeStatus,
    // 派生镜像，跟 mergeStatus.conflicted 保持一致供现有冲突角标直接读
    hasConflict: mergeStatus.conflicted,
  };
}

function compareVersion(actual: string, min: readonly [number, number, number]): number {
  const parts = actual.split('.').map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < min.length; i++) {
    const a = Number.isNaN(parts[i] ?? 0) ? 0 : (parts[i] ?? 0);
    const m = min[i] ?? 0;
    if (a !== m) return a - m;
  }
  return 0;
}
