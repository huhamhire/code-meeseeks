/**
 * 「纯分支合并」判定（AutoPilot 第一步 judge 的背景输入，见 docs/arch/06-agent.md）：分支合并 / 回合并
 * 把已评审过的分支改动同步到另一分支，无原创工作，自动预评审无意义。
 *
 * **判定以实际提交结构为准**：PR 提交**全为 merge commit**（无原创非 merge 提交）→ 纯合并。需调用方先经
 * commits API 拉取提交（远端元数据，不碰本地 git）后传入；未提供 commits 则无法定论（`isBranchMerge:false`、
 * basis `inconclusive`），绝不仅凭分支名定论。
 *
 * 源分支是否为长期 / 集成分支（main / develop / release/* 等）单独以 `sourceMainline` 给出——它**只是背景
 * 信号**（疑似回合并 / 同步的线索），不单独判定是否分支合并；调用方可据此决定是否值得拉 commits 复核，并
 * 把该信号一并交给 LLM judge 由其权衡，而非据此直接跳过。
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
  /** 「纯分支合并」：提交全为 merge commit（无原创非 merge 提交）。仅在提供 commits 时可定论。 */
  isBranchMerge: boolean;
  /** 判定依据：提交结构 / 未提供 commits 无法定论。 */
  basis: 'commits' | 'inconclusive';
  /** 源分支是否为长期 / 集成分支（背景信号，供 judge 参考，不单独定论是否分支合并）。 */
  sourceMainline: boolean;
}

/**
 * 判定一个 PR 是否「纯分支合并」。给了 commits 才能定论（全 merge commit → true）；未给则 inconclusive
 * （调用方据 `sourceMainline` 等决定是否拉 commits 复核，或交给 LLM judge）。分支名只填 `sourceMainline`
 * 背景信号，不参与 isBranchMerge 定论。
 */
export function classifyBranchMerge(input: BranchMergeInput): BranchMergeVerdict {
  const sourceMainline = isMainlineBranch(input.sourceBranch);
  if (input.commits) {
    const allMerges = input.commits.length > 0 && input.commits.every((c) => c.parents.length > 1);
    return { isBranchMerge: allMerges, basis: 'commits', sourceMainline };
  }
  return { isBranchMerge: false, basis: 'inconclusive', sourceMainline };
}
