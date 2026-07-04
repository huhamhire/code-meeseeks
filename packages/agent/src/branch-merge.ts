/**
 * "Pure branch merge" judge (background input for AutoPilot's first-step judge, see docs/arch/02-agent/01-agent.md): a branch merge / back-merge
 * syncs already-reviewed branch changes to another branch, with no original work, so an automatic pre-review is meaningless.
 *
 * **The judgment is based on the actual commit structure**: PR commits are **all merge commits** (no original non-merge commits) → pure merge. The caller must first
 * pull commits via the commits API (remote metadata, does not touch local git) and pass them in; if commits are not provided the result is inconclusive (`isBranchMerge:false`,
 * basis `inconclusive`), never conclude from the branch name alone.
 *
 * Whether the source branch is a long-lived / integration branch (main / develop / release/* etc.) is given separately as `sourceMainline` — it is **only a background
 * signal** (a hint of a suspected back-merge / sync), not judged alone for whether it is a branch merge; the caller may use it to decide whether it is worth pulling commits to recheck, and
 * pass the signal along to the LLM judge to weigh, rather than skipping directly based on it.
 */

const MAINLINE_EXACT = new Set(['main', 'master', 'develop', 'dev', 'trunk']);
const MAINLINE_PREFIX = ['release/', 'hotfix/'];

/** Whether the source branch is a long-lived / integration branch (its changes are usually already reviewed in their own PR). */
export function isMainlineBranch(branch: string): boolean {
  const b = branch.trim().toLowerCase();
  return MAINLINE_EXACT.has(b) || MAINLINE_PREFIX.some((p) => b.startsWith(p));
}

export interface BranchMergeInput {
  sourceBranch: string;
  targetBranch: string;
  /** PR commits (optional); (c) when uncertain, the caller pulls and passes them in to make the (b) judgment. */
  commits?: ReadonlyArray<{ parents: string[] }>;
}

export interface BranchMergeVerdict {
  /** "Pure branch merge": commits are all merge commits (no original non-merge commits). Conclusive only when commits are provided. */
  isBranchMerge: boolean;
  /** Judgment basis: commit structure / inconclusive when commits are not provided. */
  basis: 'commits' | 'inconclusive';
  /** Whether the source branch is a long-lived / integration branch (background signal for the judge's reference, not judged alone for whether it is a branch merge). */
  sourceMainline: boolean;
}

/**
 * Judge whether a PR is a "pure branch merge". Conclusive only when commits are given (all merge commits → true); otherwise inconclusive
 * (the caller decides whether to pull commits to recheck based on `sourceMainline` etc., or defers to the LLM judge). The branch name only fills the `sourceMainline`
 * background signal, and does not participate in the isBranchMerge conclusion.
 */
export function classifyBranchMerge(input: BranchMergeInput): BranchMergeVerdict {
  const sourceMainline = isMainlineBranch(input.sourceBranch);
  if (input.commits) {
    const allMerges = input.commits.length > 0 && input.commits.every((c) => c.parents.length > 1);
    return { isBranchMerge: allMerges, basis: 'commits', sourceMainline };
  }
  return { isBranchMerge: false, basis: 'inconclusive', sourceMainline };
}
