import type { PingResult, PlatformAdapter, PlatformUser, PullRequest } from '@pr-pilot/shared';
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

const MIN_VERSION: readonly [number, number, number] = [7, 0, 0];

export class BitbucketServerAdapter implements PlatformAdapter {
  readonly kind = 'bitbucket-server' as const;
  private readonly client: BBClient;
  private cachedUser: PlatformUser | null = null;

  constructor(opts: BBClientOptions) {
    this.client = new BBClient(opts);
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
    const out: PullRequest[] = [];
    for await (const pr of this.client.paginate<BBPullRequest>(
      '/rest/api/1.0/dashboard/pull-requests',
      { role: 'REVIEWER', state: 'OPEN' },
    )) {
      out.push(mapPullRequest(pr));
    }
    return out;
  }
}

function mapUser(u: BBUser): PlatformUser {
  return { name: u.name, displayName: u.displayName };
}

function mapPullRequest(bb: BBPullRequest): PullRequest {
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
