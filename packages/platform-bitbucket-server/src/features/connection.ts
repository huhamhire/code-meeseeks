import type { PingResult, PlatformCapabilities, RepoRef } from '@meebox/shared';
import { BaseConnection, type ConnectionContext } from '@meebox/platform-core';
import type { BitbucketClient } from '../client.js';
import type { BitbucketApplicationProperties, BitbucketUser } from '../types.js';

/** 支持的 Bitbucket Server 最低版本（multilineMarker 等关键能力 7.0 起）。 */
const MIN_VERSION: readonly [number, number, number] = [7, 0, 0];

/**
 * Bitbucket Server 连接领域：能力声明、连接探测（版本下限 + 当前用户）、PAT/SSH clone URL。
 */
export class BitbucketServerConnection extends BaseConnection {
  readonly kind = 'bitbucket-server' as const;

  constructor(
    ctx: ConnectionContext,
    private readonly client: BitbucketClient,
  ) {
    super(ctx);
  }

  /**
   * Bitbucket Server 能力：三态审批、行内多行评论、删改乐观锁、否决项逐条（/merge vetoes）。
   *
   * 无「解决线程 / 代码 suggestion / pending-review 成组」概念；dashboard 发现不强限流；
   * dashboard 支持 role=REVIEWER/AUTHOR → 提供「待我评审 / 我创建的」两类发现。
   */
  capabilities(): PlatformCapabilities {
    return {
      reviewStatuses: ['approved', 'needsWork', 'unapproved'],
      inlineComments: true,
      inlineMultiline: true,
      commentOptimisticLock: true,
      commentHardBreaks: true,
      mergeVetoFidelity: 'full',
      discoveryRateLimited: false,
      discoveryFilters: ['review-requested', 'created'],
      resolvableThreads: false,
      suggestions: false,
      reviewGrouping: false,
      activityTimeline: true,
    };
  }

  /**
   * 连接探测：读 application-properties 取版本，从响应头 X-AUSERNAME 取当前用户 slug 再查
   * displayName 落地缓存。
   *
   * 版本低于硬下限（{@link MIN_VERSION}）时 ok=false 并给出 reason；/users/{slug} 失败时退而用
   * slug 充当 displayName。
   */
  async ping(): Promise<PingResult> {
    const { body: props, headers } =
      await this.client.getWithHeaders<BitbucketApplicationProperties>(
        '/rest/api/1.0/application-properties',
      );

    // 当前用户从响应头 X-AUSERNAME (slug) 拿，再查 /users/{slug} 拿 displayName
    const slug = headers.get('x-ausername');
    if (slug) {
      try {
        const u = await this.client.get<BitbucketUser>(
          `/rest/api/1.0/users/${encodeURIComponent(slug)}`,
        );
        this.setCurrentUser({ name: u.name, displayName: u.displayName, slug: u.slug });
      } catch {
        // /users/{slug} 失败时退而求其次，slug 当 displayName
        this.setCurrentUser({ name: slug, displayName: slug, slug });
      }
    }

    const user = this.getCurrentUser() ?? undefined;
    const cmp = this.compareVersion(props.version, MIN_VERSION);
    if (cmp >= 0) {
      return { ok: true, serverVersion: props.version, user };
    }
    return {
      ok: false,
      serverVersion: props.version,
      user,
      reason: `未支持的 Bitbucket Server 版本：${props.version}；最低要求 ${MIN_VERSION.join('.')}`,
    };
  }

  /**
   * 构造仓库的 git clone URL（PAT 内嵌当前用户名 / ssh scp-like，按连接 clone 协议切分）。
   */
  async getCloneUrl(repo: RepoRef): Promise<string> {
    return this.client.getCloneUrl(repo, this.getCurrentUser()?.name);
  }

  /**
   * 比较版本号：逐段数值比较 `actual` 与最低要求，返回正/零/负表示 ≥ / = / <。
   *
   * 非数字段按 0 处理，容错形如 `7.21.0-build` 的尾缀。
   */
  private compareVersion(actual: string, min: readonly [number, number, number]): number {
    const parts = actual.split('.').map((s) => Number.parseInt(s, 10));
    for (let i = 0; i < min.length; i++) {
      const a = Number.isNaN(parts[i] ?? 0) ? 0 : (parts[i] ?? 0);
      const m = min[i] ?? 0;
      if (a !== m) return a - m;
    }
    return 0;
  }
}
