import { useSyncExternalStore } from 'react';
import type { PragentRunInfo } from '@meebox/shared';
import { invoke, subscribe } from '../api';

/**
 * 跨 ChatPane 实例的 pr-agent run 队列 + 实时 stdout 缓存。放模块级 store 而不是
 * React 状态，原因：用户切 PR 时 ChatPane 会被卸载重建，但 pr-agent 在主进程仍
 * 在跑、还在持续发 `pragent:runProgress` 事件 —— 把 (active, waiting, 已收到的
 * lines) 提到 React 树之上，新挂载的 ChatPane 能立刻读到正确状态。
 *
 * 数据 immutable 替换 (linesByRunId 用全新 Map / 数组，waiting 用新数组)，配合
 * useSyncExternalStore 的 identity 检查触发 re-render。
 */
export interface ChatRunStoreState {
  /** 当前并发运行中的 run 列表（长度 ≤ max_concurrency）。空数组表示当前无 run 在跑 */
  active: ReadonlyArray<PragentRunInfo>;
  /** 等待执行的 run 队列 (FIFO，前面的先跑)。空数组表示无人排队 */
  waiting: ReadonlyArray<PragentRunInfo>;
  /** 各 run 的实时 stdout 行缓存。键 = runId；run 完成后保留直到 clearLines 调用 */
  linesByRunId: ReadonlyMap<string, ReadonlyArray<string>>;
}

let state: ChatRunStoreState = { active: [], waiting: [], linesByRunId: new Map() };
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

function sameRunList(
  a: ReadonlyArray<PragentRunInfo>,
  b: ReadonlyArray<PragentRunInfo>,
): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.runId === b[i]?.runId && x.startedAt === b[i]?.startedAt)
  );
}

function setQueue(
  active: ReadonlyArray<PragentRunInfo>,
  waiting: ReadonlyArray<PragentRunInfo>,
): void {
  // 浅相等优化：active / waiting 的 runId(+startedAt) 序列都没变 → 不通知，避免无谓 re-render
  if (sameRunList(state.active, active) && sameRunList(state.waiting, waiting)) return;
  state = { ...state, active, waiting };
  notify();
}

function appendLine(runId: string, line: string): void {
  const cur = state.linesByRunId.get(runId) ?? [];
  const nextMap = new Map(state.linesByRunId);
  nextMap.set(runId, [...cur, line]);
  state = { ...state, linesByRunId: nextMap };
  notify();
}

function clearLines(runId: string): void {
  if (!state.linesByRunId.has(runId)) return;
  const nextMap = new Map(state.linesByRunId);
  nextMap.delete(runId);
  state = { ...state, linesByRunId: nextMap };
  notify();
}

export const chatRunStore = {
  getSnapshot: (): ChatRunStoreState => state,
  subscribe: (cb: () => void): (() => void) => {
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  },
  setQueue,
  appendLine,
  clearLines,
};

export function useChatRunStore(): ChatRunStoreState {
  return useSyncExternalStore(chatRunStore.subscribe, chatRunStore.getSnapshot);
}

/**
 * 把 IPC → store 的数据流接起来。在 App 顶层 useEffect 调用一次。
 * - 启动时拉一次队列快照兜底 (window reload / preload 重连后仍能恢复 UI)
 * - 订阅 queueChanged 事件，更新 store.active + store.waiting
 * - 订阅 runProgress 事件，把 line 追加到对应 runId 的 lines 缓存
 *
 * 返回 cleanup 函数，App unmount 时一并取消订阅。
 */
export function wireChatRunStore(): () => void {
  let cancelled = false;
  void (async () => {
    try {
      const snap = await invoke('pragent:queue', undefined);
      if (!cancelled) chatRunStore.setQueue(snap.active, snap.waiting);
    } catch {
      // 启动阶段拿不到队列也不致命，等事件兜
    }
  })();
  const unsubQueue = subscribe('pragent:queueChanged', (ev) => {
    chatRunStore.setQueue(ev.active, ev.waiting);
  });
  const unsubProgress = subscribe('pragent:runProgress', (ev) => {
    chatRunStore.appendLine(ev.runId, ev.line);
  });
  return () => {
    cancelled = true;
    unsubQueue();
    unsubProgress();
  };
}
