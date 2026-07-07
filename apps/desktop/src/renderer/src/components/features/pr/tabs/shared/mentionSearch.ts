import type { PlatformUser } from '@meebox/shared';
import { invoke } from '../../../../../api';

/** Minimum query length before hitting remote user search (mirrors the main-side guard; avoids a request per keystroke). */
const MIN_QUERY = 2;

/**
 * Remote `@mention` user search bound to a PR: resolves matching platform users via the `mentions:search` IPC channel,
 * for the mention editor's remote fallback (see MentionTextarea). Returns [] for a too-short query or any failure so
 * autocomplete degrades silently to the local candidate menu and never blocks typing.
 *
 * Only meaningful when the active platform's `userSearch` capability is true; callers gate on it before wiring this in.
 */
export async function searchMentionUsers(prLocalId: string, query: string): Promise<PlatformUser[]> {
  const q = query.trim();
  if (q.length < MIN_QUERY) return [];
  try {
    return await invoke('mentions:search', { localId: prLocalId, query: q });
  } catch {
    return [];
  }
}
