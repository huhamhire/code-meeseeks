// 命令面板 MRU（最近使用）：仅存顶层命令 id 的小列表，用于「打开即预选上次用的命令」。
// 纯本机 UI 顺手优化，存 localStorage（与主题 / 语言持久化同套，无 IPC）；丢失无碍（下次重新积累）。
// 存成小列表（非单值）以便将来升级到「最近使用置顶分组」时不必改存储格式。

const KEY = 'meebox.commandPalette.mru';
const CAP = 8;

/** 读 MRU（最近在前）；缺失 / 损坏 / localStorage 不可用一律当空。 */
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

/** 记一次使用：把 id 提到最前、去重、封顶后写回。localStorage 不可用时静默跳过。 */
export function pushMru(id: string): void {
  try {
    const next = [id, ...readMru().filter((x) => x !== id)].slice(0, CAP);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 仅为顺手优化，写失败忽略
  }
}
