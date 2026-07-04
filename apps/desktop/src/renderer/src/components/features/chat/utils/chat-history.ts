// Input history: last 5 successful submissions, persisted to localStorage. Up/Down keys
// replay it when the caret is at the end of the textarea. Focus stays on the textarea after a hit / dismiss
const CHAT_HISTORY_KEY = 'meebox.chatHistory';
export const CHAT_HISTORY_MAX = 5;

export function loadChatHistory(): string[] {
  try {
    const raw = localStorage.getItem(CHAT_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensively filter out non-string items and cap to the limit (won't blow up if the history schema changed)
    return parsed.filter((v): v is string => typeof v === 'string').slice(0, CHAT_HISTORY_MAX);
  } catch {
    return [];
  }
}

export function pushChatHistory(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return loadChatHistory();
  const prev = loadChatHistory();
  // Dedupe: don't push again if identical to the most recent entry (users typing the same command repeatedly is common). Also
  // remove duplicate older entries from history so the latest one moves to the top
  const deduped = prev.filter((v) => v !== trimmed);
  const next = [trimmed, ...deduped].slice(0, CHAT_HISTORY_MAX);
  try {
    localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode → fine as long as in-memory history keeps working */
  }
  return next;
}
