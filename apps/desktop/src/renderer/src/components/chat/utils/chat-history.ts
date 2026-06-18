// 输入历史：最近 5 次成功提交，localStorage 持久化。Up/Down 按键在 textarea 末尾
// 输入位置时回放。命中 / dismissed 后焦点保持在 textarea 上
const CHAT_HISTORY_KEY = 'meebox.chatHistory';
export const CHAT_HISTORY_MAX = 5;

export function loadChatHistory(): string[] {
  try {
    const raw = localStorage.getItem(CHAT_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 防御性筛掉非 string 项，并截到上限 (历史 schema 改过也不爆)
    return parsed.filter((v): v is string => typeof v === 'string').slice(0, CHAT_HISTORY_MAX);
  } catch {
    return [];
  }
}

export function pushChatHistory(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return loadChatHistory();
  const prev = loadChatHistory();
  // 去重：跟最近一条一样不重复入栈 (用户连续打同样命令很常见)。也清掉历史里
  // 重复的旧条目，让最新的那条上移到顶
  const deduped = prev.filter((v) => v !== trimmed);
  const next = [trimmed, ...deduped].slice(0, CHAT_HISTORY_MAX);
  try {
    localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode → 内存里历史能继续工作就行 */
  }
  return next;
}
