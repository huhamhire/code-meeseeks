// Platform-layer unified backend status codes: the backend only emits **stable, neutral codes**, never assembling user-facing localized text; localization is done by the frontend per code
// (see docs/arch/01-platform/01-adapter.md §2 and docs/arch/99-core/04-error-codes.md).
// Each platform adapter normalizes its own native status to these codes; the frontend does i18n per code (`mergeVeto.<code>` in renderer locales).

/** Merge veto reason codes (GitHub mergeable_state / GitLab detailed_merge_status etc. normalize to these). */
export const MERGE_VETO_CODES = [
  /** A merge conflict exists. */
  'conflict',
  /** Blocked by branch protection (required review / required checks not passed). */
  'branchProtected',
  /** Behind the target branch, needs updating / rebase first. */
  'behind',
  /** Required checks not passed / CI in progress. */
  'checksFailed',
  /** Mergeable state being computed. */
  'checking',
  /** Draft / WIP, needs to be marked as ready to merge. */
  'draft',
  /** Unresolved discussions exist. */
  'discussionsUnresolved',
  /** Approval requirements not met. */
  'notApproved',
  /** PR / MR is not in open state. */
  'notOpen',
  /** Blocked by another merge request. */
  'blockedByDependency',
  /** Remote deems it currently not mergeable (other / unspecified reason). */
  'notMergeable',
] as const;

export type MergeVetoCode = (typeof MERGE_VETO_CODES)[number];
