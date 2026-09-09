import { writePrMeta } from '@meebox/poller';
import { AppError, ERROR_CODES, type StoredPullRequest } from '@meebox/shared';
import type { ServiceContext } from './context.js';

/**
 * Post-action remote reconciliation: after a write action (merge / review verdict) the platform does **not** settle
 * synchronously — the call returns as soon as the request is accepted, while the state the UI reads is recomputed
 * asynchronously on the remote and lands some seconds later:
 *
 * - **merge**: the PR keeps reporting `state: 'open'` and keeps appearing in the discovery list for a moment, so a
 *   refresh fired the instant the merge returns still shows the PR sitting in the list as if nothing happened;
 * - **review verdict**: `mergeStatus.canMerge` is a server-side verdict over approvals / builds / branch protection.
 *   An approval that satisfies the last required rule flips it to true — but only once the remote has recomputed it,
 *   which is after the approve call has already returned.
 *
 * A single immediate refresh therefore reads pre-action state and looks like nothing happened; leaving it to the
 * periodic poll means waiting a whole interval. So both actions kick off a **backoff re-check** here: refresh the one
 * PR on a growing delay until the expected change shows up (or the attempts run out, where the periodic poll remains
 * the backstop), and broadcast `prs:changed` whenever the state actually moved so the renderer reloads.
 *
 * Living in main rather than in the renderer keeps every entry point covered by one implementation: the merge / approve
 * buttons, the chat `/merge` `/approve` commands, and the CLI's review write actions all route through the same
 * controllers (see services/api-server/routes/pr.ts).
 */

/**
 * Delays before each re-check attempt, in ms. The first is short because the common case is a remote that has already
 * settled by the time the action returns, and that attempt sets the latency the user actually perceives; the rest grow
 * to cover a slow remote without hammering it. The tail (~15s total) is deliberately shorter than a poll interval —
 * past that, the periodic poll is the backstop and a background loop adds nothing.
 */
const RECHECK_DELAYS_MS = [400, 1_200, 3_500, 10_000] as const;

/**
 * Confirmation loops already running, keyed by `<what>:<localId>`, so repeated clicks don't stack duplicate loops.
 * Keyed by kind as well as PR: approving and then merging the same PR are two independent settlements, and a merge
 * confirmation must not be dropped just because the verdict's loop is still winding down.
 */
const inFlight = new Set<string>();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Re-fetch one PR from the remote and persist it, returning the updated record (null when the PR is gone locally).
 *
 * Shared by the `prs:refreshOne` handler and the confirmation loops below. `invalidateComments` is what separates the
 * two callers: a user-driven refresh wants comments re-fetched as well, while a background confirmation only cares
 * about PR metadata — invalidating on every attempt would make the open comment / diff panes re-fetch several times
 * over for a state the user never asked about.
 */
export async function refreshSinglePr(
  ctx: ServiceContext,
  localId: string,
  opts: { invalidateComments: boolean },
): Promise<StoredPullRequest> {
  const existing = await ctx.pr.findPrOrThrow(localId);
  const adapter = ctx.pr.adapterForOrThrow(existing);
  // Remote fetch of just this PR. 403/404 normalize to error codes (matching openPrByUrl); other errors bubble up.
  let fresh;
  try {
    fresh = await adapter.prs.getSinglePullRequest(
      { projectKey: existing.repo.projectKey, repoSlug: existing.repo.repoSlug },
      existing.remoteId,
    );
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    if (status === 403) throw new AppError(ERROR_CODES.PR_FORBIDDEN, undefined, 'forbidden');
    if (status === 404) throw new AppError(ERROR_CODES.PR_NOT_FOUND, undefined, 'not found');
    throw err;
  }
  // localStatus mirrors the remote current user's reviewer status (remote authoritative, same mapping as the poll);
  // when the current user is unknown (ping incomplete) keep the recorded status rather than downgrading to pending.
  const me = adapter.connection.getCurrentUser();
  const mineStatus = me ? fresh.reviewers.find((r) => r.name === me.name)?.status : undefined;
  const localStatus = !me
    ? existing.localStatus
    : mineStatus === 'approved'
      ? 'approved'
      : mineStatus === 'needsWork'
        ? 'needs_work'
        : 'pending';
  const stored: StoredPullRequest = {
    ...fresh,
    localId: existing.localId,
    platform: existing.platform,
    connectionId: existing.connectionId,
    localStatus,
    // Preserve local-only bookkeeping (a single-PR refresh isn't a discovery pass).
    discoveryFilters: existing.discoveryFilters,
    discoveredAt: existing.discoveredAt,
    lastSeenAt: new Date().toISOString(),
  };
  await writePrMeta(await ctx.pr.storeForPr(localId), localId, stored);
  if (opts.invalidateComments) await ctx.pr.invalidateCommentsCache(localId);
  if (fresh.sourceRef.sha !== existing.sourceRef.sha) {
    try {
      await ctx.pr.ensureMirrorReadyForPr(stored);
    } catch {
      /* non-fatal: the diff view self-heals / surfaces a readable error if the mirror still lacks the sha */
    }
  }
  return stored;
}

/**
 * Run the backoff re-check loop for one PR: refresh, hand the result to `settled`, and stop as soon as it reports the
 * expected change (or the attempts run out). Errors on an individual attempt are swallowed and retried — a transient
 * remote hiccup shouldn't abort the confirmation, and a PR that vanished locally (archived by a concurrent poll) ends
 * the loop, since there is nothing left to confirm.
 */
async function recheckUntilSettled(
  ctx: ServiceContext,
  localId: string,
  what: 'merge' | 'review-verdict',
  settled: (pr: StoredPullRequest) => boolean,
): Promise<void> {
  const key = `${what}:${localId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    for (const delay of RECHECK_DELAYS_MS) {
      await sleep(delay);
      let pr: StoredPullRequest;
      try {
        pr = await refreshSinglePr(ctx, localId, { invalidateComments: false });
      } catch (err) {
        if (err instanceof AppError && err.code === ERROR_CODES.PR_NOT_FOUND) return;
        ctx.logger.debug({ err, localId, what }, 'post-action recheck attempt failed; retrying');
        continue;
      }
      if (!settled(pr)) {
        // Not the change we're waiting for, but the attempt has still persisted fresh remote state (reviewer verdicts,
        // vetoes, head sha); leaving that on disk unannounced would show a list disagreeing with what was just stored.
        // Reloading is a local read, so the extra broadcast costs nothing.
        ctx.broadcast('prs:changed', { localId });
        continue;
      }
      // The remote has settled. The list filters on archivedAt, not on PR state, so a merged PR only disappears once it
      // is archived — archive this one directly rather than running a full poll tick for it: a tick would fetch every
      // connection's discovery lists before the PR the user just merged could leave, and all of that is latency the user
      // watches. The departure a poll infers from absence is already established here by the confirmed remote state.
      if (what === 'merge') {
        try {
          await ctx.poller.archivePullRequest(localId);
        } catch (err) {
          ctx.logger.warn({ err, localId }, 'archiving the merged PR failed; the periodic poll will catch up');
        }
      }
      ctx.logger.info({ localId, what }, 'post-action remote state settled');
      ctx.broadcast('prs:changed', { localId });
      return;
    }
    ctx.logger.debug(
      { localId, what },
      'post-action remote state did not settle within the recheck window; leaving it to the periodic poll',
    );
  } finally {
    inFlight.delete(key);
  }
}

/**
 * After a merge is accepted: confirm the PR actually left the open state, then archive it through a poll tick so it
 * disappears from the list. Fire-and-forget — the merge IPC returns immediately and the button must not stay busy for
 * the length of the confirmation.
 */
export function confirmMergeSettled(ctx: ServiceContext, localId: string): void {
  void recheckUntilSettled(ctx, localId, 'merge', (pr) => pr.state !== 'open');
}

/**
 * After a review verdict is written: confirm whether it changed the remote's mergeability verdict, so the merge button
 * appears (or disappears) without waiting for the periodic poll. `before` is the canMerge value observed at the moment
 * the verdict was written; any move away from it is the settlement we're waiting for.
 */
export function confirmMergeabilityAfterReview(
  ctx: ServiceContext,
  localId: string,
  before: boolean,
): void {
  void recheckUntilSettled(
    ctx,
    localId,
    'review-verdict',
    (pr) => pr.mergeStatus.canMerge !== before,
  );
}
