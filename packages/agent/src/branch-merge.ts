/**
 * 「纯分支合并」判定（AutoPilot 第一步 judge 的背景输入，见 docs/arch/06-agent.md）：分支合并 / 回合并
 * 把已评审过的分支改动同步到另一分支，无原创工作，自动预评审无意义。判定**只用元数据**，分两级：
 * - (c) 分支约定：源分支是长期 / 集成分支（main / develop / release/* 等）→ 把它合进别处即回合并 / 同步。
 *   纯元数据、零成本、零网络。
 * - (b) 提交结构（(c) 拿不准时）：PR 提交**全为 merge commit**（无原创非 merge 提交）→ 纯合并。需调用方
 *   先经 commits API 拉取提交（远端元数据，不碰本地 git）后传入。
 *
 * 个人仓库 / fork 贡献 PR 的源分支通常是 feature 分支、不命中 (c)，且含原创提交、不命中 (b)，故天然不误判。
 */

const MAINLINE_EXACT = new Set(['main', 'master', 'develop', 'dev', 'trunk']);
const MAINLINE_PREFIX = ['release/', 'hotfix/'];

/** 源分支是否为长期 / 集成分支（其改动通常已在自身 PR 评审过）。 */
export function isMainlineBranch(branch: string): boolean {
  const b = branch.trim().toLowerCase();
  return MAINLINE_EXACT.has(b) || MAINLINE_PREFIX.some((p) => b.startsWith(p));
}

export interface BranchMergeInput {
  sourceBranch: string;
  targetBranch: string;
  /** PR 提交（可选）；(c) 拿不准时由调用方拉取后传入做 (b) 判定。 */
  commits?: ReadonlyArray<{ parents: string[] }>;
}

export interface BranchMergeVerdict {
  isBranchMerge: boolean;
  /** 判定依据：分支约定 (c) / 提交结构 (b) / 无法判断（未提供 commits 且不命中 (c)）。 */
  basis: 'branch-convention' | 'commits' | 'inconclusive';
}

/**
 * 判定一个 PR 是否「纯分支合并」。(c) 优先（零成本）；不命中且给了 commits 才走 (b)；都不命中 → inconclusive
 * （调用方据此决定是否拉 commits 再判一次，或交给 LLM judge）。
 */
export function classifyBranchMerge(input: BranchMergeInput): BranchMergeVerdict {
  if (isMainlineBranch(input.sourceBranch)) {
    return { isBranchMerge: true, basis: 'branch-convention' };
  }
  if (input.commits) {
    const allMerges = input.commits.length > 0 && input.commits.every((c) => c.parents.length > 1);
    return { isBranchMerge: allMerges, basis: 'commits' };
  }
  return { isBranchMerge: false, basis: 'inconclusive' };
}
