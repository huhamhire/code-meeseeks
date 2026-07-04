import type { StateStore } from '@meebox/state-store';

/**
 * PR diff base (merge-base) pinned file. Lives at `prs/<localId>/diff-base.json`.
 *
 * **Why pin it**: the semantic base of a PR diff should be "where the source branch diverged from the target branch" = `merge-base(target, head)`,
 * not the target branch's current tip (`targetRef.sha`, which moves forward as other PRs merge in).
 * - The changed-files list / changed lines use three-dot diff (`base...head`), already implicitly computed against merge-base, stable against target advancing;
 * - but **file content** (Monaco's left pane), if read against `targetRef.sha`, makes the editor an actual two-dot comparison, and after target drifts other PRs'
 *   changes leak in as "inversions/reverts". Once merge-base is pinned, content / list / counts / blame / pr-agent
 *   all use it as base, the editor is a true three-dot and stable against target drift, and comment / finding line anchors gain a fixed reference.
 *
 * **Invalidation**: recomputed when `head` (`sourceRef.sha`) is rebased so the pinned base is no longer its ancestor; also recomputed when the source branch
 * merges the current target branch in, to avoid the old divergence point counting the merge's target-branch changes into the PR diff.
 * A normal source-branch push (head only advances) does not invalidate; the base stays anchored at the divergence point.
 *
 * It is a **local derived cache**, not platform metadata, kept as its own file and untouched when poller rewrites meta.json.
 */
export interface DiffBaseCacheFile {
  schema_version: 1;
  /** The pinned merge-base sha, used as the unified base for diff/content/counts/blame/pr-agent */
  base_sha: string;
  /** The head (sourceRef.sha) corresponding to when this base was computed, for troubleshooting and manual verification */
  head_sha: string;
  /** ISO time when the computation completed */
  computed_at: string;
}

export interface DiffBaseCacheReuseInput {
  cachedBaseSha: string;
  targetSha: string;
  headSha: string;
  isAncestor: (ancestor: string, descendant: string) => Promise<boolean>;
}

export async function isDiffBaseCacheReusable(input: DiffBaseCacheReuseInput): Promise<boolean> {
  const { cachedBaseSha, targetSha, headSha, isAncestor } = input;
  if (!(await isAncestor(cachedBaseSha, headSha))) return false;
  // After the source branch merges the target branch, target becomes an ancestor of head; keeping the old divergence point
  // would count this merge's target-branch changes into the PR diff too, so it must be recomputed to the new merge-base (usually target itself).
  if (targetSha !== cachedBaseSha && (await isAncestor(targetSha, headSha))) return false;
  return true;
}

export function diffBaseCacheKey(localId: string): string {
  return `prs/${localId}/diff-base`;
}

export async function readDiffBaseCache(
  store: StateStore,
  localId: string,
): Promise<DiffBaseCacheFile | null> {
  return store.read<DiffBaseCacheFile>(diffBaseCacheKey(localId));
}

export async function writeDiffBaseCache(
  store: StateStore,
  localId: string,
  data: { base_sha: string; head_sha: string; computed_at: string },
): Promise<void> {
  await store.write<DiffBaseCacheFile>(diffBaseCacheKey(localId), {
    schema_version: 1,
    ...data,
  });
}
