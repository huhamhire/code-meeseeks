import { readDiffBaseCache, writeDiffBaseCache } from '@meebox/poller';
import type { RepoIdentity, RepoMirrorManager } from '@meebox/repo-mirror';
import type { StoredPullRequest } from '@meebox/shared';
import type { JsonFileStateStore } from '@meebox/state-store';

export interface MirrorHelpers {
  ensureMirrorReadyForPr(
    pr: StoredPullRequest,
  ): Promise<{ mirrorPath: string; freshClone: boolean }>;
  resolveDiffBaseSha(pr: StoredPullRequest): Promise<string>;
}

export function createMirrorHelpers(deps: {
  repoMirror: RepoMirrorManager;
  stateStore: JsonFileStateStore;
  repoIdentityFor: (pr: StoredPullRequest) => RepoIdentity;
}): MirrorHelpers {
  const { repoMirror, stateStore, repoIdentityFor } = deps;

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
  const ensureMirrorReadyForPr = async (
    pr: StoredPullRequest,
  ): Promise<{ mirrorPath: string; freshClone: boolean }> => {
    const id = repoIdentityFor(pr);
    const [hasHead, hasBase] = await Promise.all([
      repoMirror.hasCommit(id, pr.sourceRef.sha),
      repoMirror.hasCommit(id, pr.targetRef.sha),
    ]);
    if (hasHead && hasBase) {
      // 快速路径：mirror 已含 head + base，直接回不打远端。命中频繁，不打 log
      return { mirrorPath: repoMirror.mirrorPath(id), freshClone: false };
    }
    const r = await repoMirror.syncMirror(id);
    return { mirrorPath: r.mirrorPath, freshClone: r.freshClone };
  };

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
  const resolveDiffBaseSha = async (pr: StoredPullRequest): Promise<string> => {
    const id = repoIdentityFor(pr);
    const head = pr.sourceRef.sha;
    const cached = await readDiffBaseCache(stateStore, pr.localId);
    if (cached?.base_sha && (await repoMirror.isAncestor(id, cached.base_sha, head))) {
      return cached.base_sha;
    }
    const mb = await repoMirror.mergeBase(id, pr.targetRef.sha, head);
    if (!mb) return pr.targetRef.sha;
    await writeDiffBaseCache(stateStore, pr.localId, {
      base_sha: mb,
      head_sha: head,
      computed_at: new Date().toISOString(),
    });
    return mb;
  };

  return { ensureMirrorReadyForPr, resolveDiffBaseSha };
}
