import type { StateStore } from './types.js';

/**
 * Move an entire key subtree from one store to another (e.g. an archived PR's
 * `prs/<hash>/` directory out of the active `state/` store and into the sibling
 * `archived/` store). Works across stores rooted at different directories, which a
 * single-store rename cannot — it copies via the `StateStore` abstraction
 * (`list` → `read` → `write`) and then drops the source subtree, so it never needs
 * to expose either store's filesystem root.
 *
 * Semantics:
 * - **Source authoritative**: the destination subtree is cleared first, so the source
 *   fully replaces whatever (stale / partial) data the destination held.
 * - **Idempotent / crash-tolerant**: keys are enumerated up front and the source is
 *   deleted only after every value is written. A crash mid-relocate leaves the source
 *   intact (the move simply re-runs next time); the index that flips active⇄archived is
 *   persisted only after the relocate, so an interrupted move re-derives cleanly.
 * - **Missing source → no-op** (returns 0): already relocated, or never existed.
 *
 * Only `.json` values are carried (the only thing `StateStore.list` yields); every PR
 * subtree file is JSON, so this loses nothing. Not atomic and re-serializes each file —
 * fine because relocation is rare (archive / restore transitions) and PR subtrees are small.
 *
 * @returns the number of keys relocated.
 */
export async function relocateTree(
  from: StateStore,
  to: StateStore,
  prefix: string,
): Promise<number> {
  // Enumerate before any mutation: the source is only deleted at the very end.
  const keys: string[] = [];
  for await (const key of from.list(prefix)) keys.push(key);
  if (keys.length === 0) return 0;

  // Source replaces destination wholesale — clear any stale/partial remnant first.
  await to.deleteDir(prefix);
  for (const key of keys) {
    const data = await from.read<unknown>(key);
    if (data !== null) await to.write(key, data);
  }
  await from.deleteDir(prefix);
  return keys.length;
}
