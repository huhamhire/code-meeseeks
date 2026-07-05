import type { PragentRunInfo } from '@meebox/ipc';
import type {
  LocalPrStatus,
  PlatformKind,
  PrDiscoveryFilter,
  ReviewRunTool,
  ReviewerStatus,
  StoredPullRequest,
} from '@meebox/shared';

/**
 * PR list view item: the **slim projection** exposed by `GET /prs`. This is the view-layer tree-structure constraint for the
 * request interface — a single projection function {@link toPrListItem} defines the field set and order returned by the list,
 * avoiding leaking the entire StoredPullRequest (with description details, full people objects, etc.) to list consumers.
 *
 * Narrowing principles:
 * - Give only identifiers and overview, **drop description details** (details go through `GET /prs/{id}`);
 * - **Keep only slug for people info** (reviewer additionally carries status); avatar / display name, etc. left to details;
 * - **Field order is output order**: id / title / author / createdAt first, then the remaining overview fields.
 */
export interface PrListItem {
  /** The PR's local stable identifier (== StoredPullRequest.localId); write operations and the details endpoint both locate by this. */
  id: string;
  title: string;
  /** Author slug (falls back to name when missing); no display name / avatar. */
  author: string;
  createdAt: string;
  /** Own review verdict (pending / approved / needs_work). */
  status: LocalPrStatus;
  state: 'open' | 'merged' | 'declined';
  draft: boolean;
  platform: PlatformKind;
  /** `projectKey/repoSlug`. */
  repo: string;
  /** Remote platform PR number. */
  remoteId: string;
  updatedAt: string;
  hasConflict: boolean;
  /** Remote-determined directly mergeable (== mergeStatus.canMerge). */
  mergeable: boolean;
  /** Matched discovery categories (top-level category). */
  categories: PrDiscoveryFilter[];
  /** Reviewers: slug + status only. */
  reviewers: Array<{ slug: string; status: ReviewerStatus }>;
  unread: boolean;
  unreadMentionCount: number;
}

/**
 * View item for one pr-agent run of a PR in the run queue: the projection of `GET /prs/{id}/agent/runs`. Lets the caller
 * discover cancelable runs (runId + tool + running / queued state), paired with `…/runs/{runId}/cancel` for per-run cancel.
 */
export interface PrAgentRunItem {
  runId: string;
  tool: ReviewRunTool;
  /** active = executing; waiting = queued. */
  state: 'active' | 'waiting';
  /** Execution start time (ISO); null when waiting. */
  startedAt: string | null;
  enqueuedAt: string;
  question?: string;
}

/** Filter the runs belonging to this PR from the queue snapshot (active first, waiting after), projected to slim items. */
export function toPrAgentRuns(
  queue: { active: PragentRunInfo[]; waiting: PragentRunInfo[] },
  prId: string,
): PrAgentRunItem[] {
  const pick = (r: PragentRunInfo, state: 'active' | 'waiting'): PrAgentRunItem => ({
    runId: r.runId,
    tool: r.tool,
    state,
    startedAt: r.startedAt,
    enqueuedAt: r.enqueuedAt,
    ...(r.question ? { question: r.question } : {}),
  });
  return [
    ...queue.active.filter((r) => r.prLocalId === prId).map((r) => pick(r, 'active')),
    ...queue.waiting.filter((r) => r.prLocalId === prId).map((r) => pick(r, 'waiting')),
  ];
}

/** Project a stored-state PR to a list view item. The object literal's key order is the JSON output order (the CLI view layer renders accordingly). */
export function toPrListItem(pr: StoredPullRequest): PrListItem {
  return {
    id: pr.localId,
    title: pr.title,
    author: pr.author.slug ?? pr.author.name,
    createdAt: pr.createdAt,
    status: pr.localStatus,
    state: pr.state,
    draft: pr.draft,
    platform: pr.platform,
    repo: `${pr.repo.projectKey}/${pr.repo.repoSlug}`,
    remoteId: pr.remoteId,
    updatedAt: pr.updatedAt,
    hasConflict: pr.hasConflict,
    mergeable: pr.mergeStatus?.canMerge === true,
    categories: pr.discoveryFilters,
    reviewers: pr.reviewers.map((r) => ({ slug: r.slug ?? r.name, status: r.status })),
    unread: pr.unread ?? false,
    unreadMentionCount: pr.unreadMentionCount ?? 0,
  };
}
