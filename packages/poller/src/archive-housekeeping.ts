import type { Logger } from 'pino';
import type { JsonFileStateStore, StateStore } from '@meebox/state-store';
import { PURGE_GRACE_MS, readPrIndex } from './pr-state.js';

/**
 * Startup housekeeping for the `archived/` cold store: drop archived PR trees the unified index
 * no longer references **and** that are older than the purge grace.
 *
 * Why: the per-poll hard-purge iterates index entries, so when the unified index is lost / externally
 * rebuilt, archived data loses its catalog entry and can never be reached by purge — a permanent
 * orphan (poll only re-adds *active* PRs from remote, never archived ones). This index-less fallback
 * walks the archive store directly; `sweepOrphanDirs` uses each tree's filesystem mtime as a proxy for
 * `archivedAt` (lost with the index entry). Conservative on two axes — absent from index AND aged past
 * grace — so a healthy index sweeps nothing and a momentarily index-less tree is never nuked.
 *
 * Run only at startup, before any write (single-writer): no in-flight relocate can be mistaken for an orphan.
 *
 * @returns number of orphan trees removed.
 */
export async function sweepOrphanedArchivedPrs(opts: {
  /** active store — read the unified index from here to learn which hashes are still catalogued */
  stateStore: StateStore;
  /** archive cold store (concrete: needs `sweepOrphanDirs` filesystem access) */
  archiveStore: JsonFileStateStore;
  /** injectable clock for tests; defaults to wall clock */
  now?: () => Date;
  logger?: Logger;
}): Promise<number> {
  const index = await readPrIndex(opts.stateStore);
  // keep every hash the index still knows (active or archived) — only truly orphaned trees fall through
  const keep = new Set(index ? Object.keys(index.prs) : []);
  const nowMs = (opts.now?.() ?? new Date()).getTime();
  const removed = await opts.archiveStore.sweepOrphanDirs('prs', keep, PURGE_GRACE_MS, nowMs);
  if (removed > 0) {
    opts.logger?.info(
      { removed },
      'archive housekeeping: swept orphaned PR trees (no index entry, aged past grace)',
    );
  }
  return removed;
}
