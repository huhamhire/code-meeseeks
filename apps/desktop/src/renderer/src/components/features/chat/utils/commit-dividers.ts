import type { TimelineEntry } from '../hooks/useChatTimeline';

export interface CommitDividers {
  /** timeline entry.key → the headSha whose boundary is drawn immediately *before* that entry. */
  before: Map<string, string>;
  /** headSha for a divider after everything, used only when the boundary has no entry to precede. */
  bottom: string | null;
}

/**
 * Place the commit boundaries in the chat timeline: every point where the reviewed commit changes, so the boundary
 * persists rather than vanishing once the new code has been reviewed.
 *
 * - **Between runs**: two consecutive runs with different `headSha` → a boundary before the newer one, separating the
 *   old-commit runs above from the new-commit ones below.
 * - **After the newest run**: the PR head has advanced past the last run's commit and nothing has reviewed it yet.
 *   The boundary belongs immediately after that last run — **not at the end of the timeline**. Those differ as soon as
 *   anything else lands (a message, a thinking step, a queued run), and anchoring to the end made the divider drift
 *   down the pane on every new bubble, as if the boundary itself kept moving. A boundary marks a point in history; it
 *   has to stay where that point is, with everything that came after it below.
 *
 * The timeline is ascending by start time; only runs that recorded a `headSha` participate (runs from before that field
 * existed are skipped, which is why the last *run* and the last *sha-bearing run* are tracked as the same cursor).
 */
export function computeCommitDividers(
  timeline: readonly TimelineEntry[],
  headSha: string | undefined,
): CommitDividers {
  const before = new Map<string, string>();
  let prevSha: string | undefined;
  let lastShaIdx = -1;
  timeline.forEach((entry, i) => {
    const sha = entry.run?.headSha;
    if (!sha) return;
    if (prevSha && sha !== prevSha) before.set(entry.key, sha);
    prevSha = sha;
    lastShaIdx = i;
  });
  // No run has recorded a sha, or the head is the one already reviewed → no trailing boundary.
  if (!headSha || !prevSha || headSha === prevSha) return { before, bottom: null };
  // Anchor the boundary before whatever first followed that last run. Nothing follows it yet → fall back to the end,
  // which is then the same position (and stops being a moving target as soon as an entry appears there).
  const next = timeline[lastShaIdx + 1];
  if (next) {
    before.set(next.key, headSha);
    return { before, bottom: null };
  }
  return { before, bottom: headSha };
}
