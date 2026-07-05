// Command palette MRU (most recently used): stores only a small list of top-level command ids, used to "preselect the last-used command on open".
// A purely local UI convenience optimization, stored in localStorage (same setup as theme / language persistence, no IPC); losing it is harmless (re-accumulated next time).
// Stored as a small list (not a single value) so that a future upgrade to "MRU pinned group" won't require changing the storage format.

const KEY = 'meebox.commandPalette.mru';
const CAP = 8;

/** Read the MRU (most recent first); missing / corrupt / localStorage unavailable are all treated as empty. */
export function readMru(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Record a use: move the id to the front, dedupe, cap, then write back. Silently skips when localStorage is unavailable. */
export function pushMru(id: string): void {
  try {
    const next = [id, ...readMru().filter((x) => x !== id)].slice(0, CAP);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Just a convenience optimization; ignore write failures
  }
}
