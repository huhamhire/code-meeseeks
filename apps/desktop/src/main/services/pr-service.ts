import type { BootstrapResult } from '@meebox/config';
import { listStoredPullRequests, readDiffBaseCache, writeDiffBaseCache } from '@meebox/poller';
import type { RepoIdentity, RepoMirrorManager } from '@meebox/repo-mirror';
import type { PlatformAdapter, StoredPullRequest } from '@meebox/shared';
import type { JsonFileStateStore } from '@meebox/state-store';
import type { ConnectionRuntime } from '../adapters.js';
import { broadcast } from './broadcast.js';

/** PrService 构造依赖（由 context 注入）。 */
export interface PrServiceDeps {
  bootstrap: BootstrapResult;
  stateStore: JsonFileStateStore;
  /** 可变连接运行时；reconfigure 原地替换内容，本服务经引用读到最新 adapters。 */
  connectionRuntime: ConnectionRuntime;
  repoMirror: RepoMirrorManager;
}

/**
 * PR 领域服务：PR 定位 / 连接 adapter 解析 / 仓库镜像就位 / diff base 解析 / 评论缓存失效。
 *
 * 把原先散落在 common/ 的 pr-lookup·mirror·comments-cache 收拢为单一强领域类，依赖经构造注入、
 * 各方法共享 `this.deps`，避免逐函数透传。controller 一律经 `ctx.pr.<method>()` 调用；调用方
 * 应以实例方法形式调用（勿解构方法，否则丢失 this 绑定）。
 */
export class PrService {
  constructor(private readonly deps: PrServiceDeps) {}

  /** 按 localId 在状态库定位 PR，找不到抛错（统一错误文案）。 */
  async findPrOrThrow(localId: string): Promise<StoredPullRequest> {
    const prs = await listStoredPullRequests(this.deps.stateStore);
    const pr = prs.find((p) => p.localId === localId);
    if (!pr) throw new Error(`PR not found in local state: ${localId}`);
    return pr;
  }

  /** PR → RepoIdentity（host / projectKey / repoSlug）；connection 缺失抛错。 */
  repoIdentityFor(pr: StoredPullRequest): RepoIdentity {
    const conn = this.deps.bootstrap.config.connections.find((c) => c.id === pr.connectionId);
    if (!conn) throw new Error(`connection not found: ${pr.connectionId}`);
    return {
      host: new URL(conn.base_url).hostname,
      projectKey: pr.repo.projectKey,
      repoSlug: pr.repo.repoSlug,
    };
  }

  /** PR 对应连接的 adapter；连接无 adapter 时返回 undefined。 */
  adapterFor(pr: StoredPullRequest): PlatformAdapter | undefined {
    return this.deps.connectionRuntime.adapters.find((a) => a.connectionId === pr.connectionId)
      ?.adapter;
  }

  /** 同 adapterFor，但无 adapter 时抛错（绝大多数 handler 走它）。 */
  adapterForOrThrow(pr: StoredPullRequest): PlatformAdapter {
    const adapter = this.adapterFor(pr);
    if (!adapter) throw new Error(`no adapter for connection ${pr.connectionId}`);
    return adapter;
  }

  /**
   * 打开 PR 时镜像就位的保障。优先快速路径：本地 bare 已含 head+base 两个 sha
   * → 直接回 mirrorPath，不打远端。两 sha 都齐意味着上次 sync 已经覆盖了本 PR
   * 的 commit 范围（PR sha 是 immutable 的），renderer 可以直接走本地 diff 计算。
   *
   * 缺 sha (任一) → 走 syncMirror 兜底走 git fetch。
   *
   * 后台 poll 在拿到 PR 状态更新后会主动 syncMirror，所以正常打开 PR 时
   * 快速路径命中率应该很高。
   */
  async ensureMirrorReadyForPr(
    pr: StoredPullRequest,
  ): Promise<{ mirrorPath: string; freshClone: boolean }> {
    const id = this.repoIdentityFor(pr);
    const [hasHead, hasBase] = await Promise.all([
      this.deps.repoMirror.hasCommit(id, pr.sourceRef.sha),
      this.deps.repoMirror.hasCommit(id, pr.targetRef.sha),
    ]);
    if (hasHead && hasBase) {
      // 快速路径：mirror 已含 head + base，直接回不打远端。命中频繁，不打 log
      return { mirrorPath: this.deps.repoMirror.mirrorPath(id), freshClone: false };
    }
    const r = await this.deps.repoMirror.syncMirror(id);
    return { mirrorPath: r.mirrorPath, freshClone: r.freshClone };
  }

  /**
   * 解析 PR diff 的固定 base（merge-base）——见 `@meebox/poller` diff-base-cache。
   *
   * PR diff 的语义基准是「源分支自目标分支分叉处」= `merge-base(targetRef.sha, sourceRef.sha)`，
   * 而非目标分支当前 tip（会随别的 PR 合入前移）。首次算出后固化于 `prs/<localId>/diff-base.json`，
   * 之后 listChangedFiles / 文件内容 / commitCount / blame / pr-agent worktree 一律以它为 base：
   * - 内容（Monaco 左栏）锚到 merge-base → 编辑器即真三点，目标漂移不再把别的 PR 改动倒挂进来；
   * - 行锚点（评论 / finding）有了固定参照，目标漂移不致错位。
   *
   * 失效重算：固化 base 不再是当前 head 的祖先（源分支被 rebase）→ 重算。head 正常 push（仅前进）
   * 不失效。算不出（缺对象 / 无共同祖先）→ 兜底退回 targetRef.sha 且**不固化**，下次再试。
   *
   * 前置：mirror 已含 head + targetRef.sha（diff 入口已 ensureMirrorReadyForPr / syncMirror）。
   */
  async resolveDiffBaseSha(pr: StoredPullRequest): Promise<string> {
    const id = this.repoIdentityFor(pr);
    const head = pr.sourceRef.sha;
    const cached = await readDiffBaseCache(this.deps.stateStore, pr.localId);
    if (cached?.base_sha && (await this.deps.repoMirror.isAncestor(id, cached.base_sha, head))) {
      return cached.base_sha;
    }
    const mb = await this.deps.repoMirror.mergeBase(id, pr.targetRef.sha, head);
    if (!mb) return pr.targetRef.sha;
    await writeDiffBaseCache(this.deps.stateStore, pr.localId, {
      base_sha: mb,
      head_sha: head,
      computed_at: new Date().toISOString(),
    });
    return mb;
  }

  /**
   * 清掉某 PR 的评论缓存并广播 `comments:changed`，让 CommentsPanel / DiffView 内嵌评论重拉刷新。
   * 收口 comments reply/delete/edit 与 drafts:publishBatch 共用的链路（清 `prs/<localId>/comments`
   * 缓存 → 下次 listComments force 拉远端 → 广播触发重拉）。cache miss 无所谓，吞掉异常。
   */
  async invalidateCommentsCache(localId: string): Promise<void> {
    try {
      await this.deps.stateStore.delete(`prs/${localId}/comments`);
    } catch {
      /* cache miss 也无所谓 */
    }
    broadcast('comments:changed', { localId });
  }
}
