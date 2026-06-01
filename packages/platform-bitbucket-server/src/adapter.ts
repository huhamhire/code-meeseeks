import type {
  PingResult,
  PlatformAdapter,
  PlatformUser,
  PrComment,
  PrCommentAnchor,
  PullRequest,
  RepoRef,
  Reviewer,
  ReviewerStatus,
} from '@pr-pilot/shared';
import { BBClient, type BBClientOptions } from './client.js';

interface BBUser {
  name: string;
  displayName: string;
  emailAddress?: string;
  active: boolean;
  slug: string;
}

interface BBRef {
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

interface BBParticipant {
  user: BBUser;
  role: 'AUTHOR' | 'REVIEWER' | 'PARTICIPANT';
  approved: boolean;
  status?: 'UNAPPROVED' | 'APPROVED' | 'NEEDS_WORK';
}

interface BBPullRequest {
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
  fromRef: BBRef;
  toRef: BBRef;
  author: BBParticipant;
  reviewers: BBParticipant[];
  links: { self: Array<{ href: string }> };
}

interface BBApplicationProperties {
  version: string;
  buildNumber: string;
  displayName: string;
}

interface BBMergeStatus {
  canMerge: boolean;
  conflicted: boolean;
  outcome: 'CLEAN' | 'CONFLICTED' | 'CONFLICTED_AND_AHEAD' | string;
  vetoes?: Array<{ summaryMessage: string; detailedMessage?: string }>;
}

interface BBComment {
  id: number;
  version: number;
  text: string;
  author: BBUser;
  createdDate: number;
  updatedDate: number;
  comments?: BBComment[];
  parent?: { id: number };
}

interface BBCommentAnchor {
  diffType?: 'EFFECTIVE' | 'COMMIT' | 'RANGE';
  line: number;
  lineType: 'ADDED' | 'REMOVED' | 'CONTEXT';
  fileType: 'FROM' | 'TO';
  path: string;
  srcPath?: string;
}

interface BBActivity {
  id: number;
  createdDate: number;
  user: BBUser;
  action: string;
  commentAction?: 'ADDED' | 'UPDATED' | 'DELETED' | 'REPLIED';
  comment?: BBComment;
  commentAnchor?: BBCommentAnchor;
}

const MIN_VERSION: readonly [number, number, number] = [7, 0, 0];

export interface BitbucketServerAdapterOptions extends BBClientOptions {
  /** clone 协议：'pat'（默认）走 HTTPS+用户名:PAT；'ssh' 走系统 ssh 配置 */
  cloneProtocol?: 'pat' | 'ssh';
}

export class BitbucketServerAdapter implements PlatformAdapter {
  readonly kind = 'bitbucket-server' as const;
  private readonly client: BBClient;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly cloneProtocol: 'pat' | 'ssh';
  private cachedUser: PlatformUser | null = null;

  constructor(opts: BitbucketServerAdapterOptions) {
    this.client = new BBClient(opts);
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.cloneProtocol = opts.cloneProtocol ?? 'pat';
  }

  /**
   * 返回 clone URL，行为按 cloneProtocol 切分：
   *
   * **pat（默认）**: `https://<当前用户名>:<PAT>@<host>/scm/<proj>/<repo>.git`
   * - BBS Server 的 PAT 鉴权要求真实用户名 (X-AUSERNAME) 作为 username，
   *   PAT 作为 password（不是 Bitbucket Cloud 的 x-token-auth）
   * - 调用前必须先 ping() 让 cachedUser 落地，否则抛
   * - 风险提示：PAT 在 URL 里会出现在 git reflog / 进程命令行，敏感场景请用 ssh
   *
   * **ssh**: `git@<host>:<proj>/<repo>.git` (scp-like)
   * - 端口 / 私钥 / username 完全由系统 `~/.ssh/config` 负责
   * - BBS Server 默认 SSH 端口 7999，需在 ssh config 里给 host 配 Port
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
    const { body: props, headers } = await this.client.getWithHeaders<BBApplicationProperties>(
      '/rest/api/1.0/application-properties',
    );

    // 当前用户从响应头 X-AUSERNAME (slug) 拿，再查 /users/{slug} 拿 displayName
    const slug = headers.get('x-ausername');
    if (slug) {
      try {
        const u = await this.client.get<BBUser>(
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

  async listPendingPullRequests(): Promise<PullRequest[]> {
    const bbPrs: BBPullRequest[] = [];
    for await (const pr of this.client.paginate<BBPullRequest>(
      '/rest/api/1.0/dashboard/pull-requests',
      { role: 'REVIEWER', state: 'OPEN' },
    )) {
      bbPrs.push(pr);
    }

    // N+1：并行抓每个 PR 的 /merge 状态拿 conflicted 字段；单个失败降级到
    // hasConflict=false（保守，不误标 ignored）
    const mergeResults = await Promise.allSettled(
      bbPrs.map((pr) => this.fetchMergeStatus(pr)),
    );

    return bbPrs.map((pr, i) => {
      const result = mergeResults[i]!;
      const hasConflict = result.status === 'fulfilled' ? result.value.conflicted : false;
      return mapPullRequest(pr, hasConflict);
    });
  }

  private async fetchMergeStatus(pr: BBPullRequest): Promise<BBMergeStatus> {
    const project = pr.toRef.repository.project.key;
    const repo = pr.toRef.repository.slug;
    return this.client.get<BBMergeStatus>(
      `/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests/${String(pr.id)}/merge`,
    );
  }

  async getUserAvatar(
    slug: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    // BBS user slug 总是小写；comments / activities 端点的 author 经常带回大小写
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

  async listPullRequestComments(repo: RepoRef, prId: string): Promise<PrComment[]> {
    // BBS 走 /activities 拿全部活动，过滤 COMMENTED + ADDED（top-level + 回复）。
    // - 跳过 DELETED / UPDATED 派生事件
    // - 跳过 reply（有 parent 字段），它们会跟着父评论的 .comments 一起出来
    // - 用 id 去重，防同一条评论多次出现
    const seen = new Set<string>();
    const out: PrComment[] = [];
    for await (const activity of this.client.paginate<BBActivity>(
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

function mapBBComment(c: BBComment, anchor?: BBCommentAnchor): PrComment {
  return {
    remoteId: String(c.id),
    author: mapUser(c.author),
    body: c.text,
    createdAt: new Date(c.createdDate).toISOString(),
    updatedAt: new Date(c.updatedDate).toISOString(),
    anchor: anchor ? mapBBAnchor(anchor) : null,
    replies: (c.comments ?? []).map((r) => mapBBComment(r)),
  };
}

function mapBBAnchor(a: BBCommentAnchor): PrCommentAnchor {
  return {
    path: a.path,
    line: a.line,
    side: a.fileType === 'FROM' ? 'old' : 'new',
    lineType: a.lineType.toLowerCase() as PrCommentAnchor['lineType'],
  };
}

function mapUser(u: BBUser): PlatformUser {
  return { name: u.name, displayName: u.displayName, slug: u.slug };
}

function mapReviewer(p: BBParticipant): Reviewer {
  // status 是 BBS 7.x+ 才有的字段；缺失时退回 approved 布尔
  let status: ReviewerStatus;
  if (p.status === 'APPROVED') status = 'approved';
  else if (p.status === 'NEEDS_WORK') status = 'needsWork';
  else if (p.status === 'UNAPPROVED') status = 'unapproved';
  else status = p.approved ? 'approved' : 'unapproved';
  return { ...mapUser(p.user), status };
}

function mapPullRequest(bb: BBPullRequest, hasConflict: boolean): PullRequest {
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
    hasConflict,
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
