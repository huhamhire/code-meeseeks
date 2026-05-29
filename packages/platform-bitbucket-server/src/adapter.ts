import type {
  PingResult,
  PlatformAdapter,
  PlatformUser,
  PullRequest,
  RepoRef,
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

const MIN_VERSION: readonly [number, number, number] = [7, 0, 0];

export class BitbucketServerAdapter implements PlatformAdapter {
  readonly kind = 'bitbucket-server' as const;
  private readonly client: BBClient;
  private readonly baseUrl: string;
  private readonly token: string;
  private cachedUser: PlatformUser | null = null;

  constructor(opts: BBClientOptions) {
    this.client = new BBClient(opts);
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
  }

  /**
   * BBS HTTPS clone URL: <baseUrl>/scm/<projectKey>/<repoSlug>.git
   * 带认证时塞 x-token-auth:<PAT>。projectKey 保留原大小写（BBS web 与 scm
   * 都是大小写敏感的）。
   */
  async getCloneUrl(repo: RepoRef, opts: { withAuth?: boolean } = {}): Promise<string> {
    const url = new URL(this.baseUrl);
    url.pathname = `/scm/${repo.projectKey}/${repo.repoSlug}.git`;
    if (opts.withAuth) {
      url.username = 'x-token-auth';
      url.password = this.token;
    }
    return url.toString();
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
        this.cachedUser = { name: u.name, displayName: u.displayName };
      } catch {
        // /users/{slug} 失败时退而求其次，slug 当 displayName
        this.cachedUser = { name: slug, displayName: slug };
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
}

function mapUser(u: BBUser): PlatformUser {
  return { name: u.name, displayName: u.displayName };
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
    reviewers: bb.reviewers.map((r) => ({ ...mapUser(r.user), approved: r.approved })),
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
