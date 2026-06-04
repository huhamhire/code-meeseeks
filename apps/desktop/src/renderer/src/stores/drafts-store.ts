import { useSyncExternalStore } from 'react';
import type { ReviewDraft } from '@meebox/shared';
import { invoke, subscribe } from '../api';

/**
 * 跨组件共享的草稿池。每个 PR 的草稿独立存一份 (按 localId 维护)，避免 PR 切换时
 * 把别 PR 的草稿洗掉。
 *
 * 数据流：
 *   main IPC `drafts:create/update/delete` → 写盘 + 广播 `drafts:changed` →
 *   本 store 收到事件 → 调 `drafts:list` 重拉 → notify subscribers
 *
 * ChatPane / DiffView 都通过 `useDraftsForPr(localId)` 读，跟 chatRunStore /
 * repoSyncStore 同模。
 */
export interface DraftsStoreState {
  /** localId → 该 PR 的全部草稿。未拉过的 PR 缺 key (UI 第一次访问会触发 hydrate) */
  byPr: ReadonlyMap<string, ReadonlyArray<ReviewDraft>>;
  /** 正在 fetch 的 localId 集合，避免重复触发 */
  loading: ReadonlySet<string>;
}

let state: DraftsStoreState = { byPr: new Map(), loading: new Set() };
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

function setForPr(localId: string, drafts: ReadonlyArray<ReviewDraft>): void {
  const nextMap = new Map(state.byPr);
  nextMap.set(localId, drafts);
  const nextLoading = new Set(state.loading);
  nextLoading.delete(localId);
  state = { byPr: nextMap, loading: nextLoading };
  notify();
}

function markLoading(localId: string): void {
  if (state.loading.has(localId)) return;
  const nextLoading = new Set(state.loading);
  nextLoading.add(localId);
  state = { ...state, loading: nextLoading };
  notify();
}

async function hydrate(localId: string): Promise<void> {
  markLoading(localId);
  try {
    const list = await invoke('drafts:list', { localId });
    setForPr(localId, list);
  } catch {
    // 失败静默；UI 看到空草稿，重试由下次 hydrate 触发
    setForPr(localId, []);
  }
}

export const draftsStore = {
  getSnapshot: (): DraftsStoreState => state,
  subscribe: (cb: () => void): (() => void) => {
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  },
  /** 强制重拉 (drafts:changed 事件触发) */
  refresh: (localId: string): Promise<void> => hydrate(localId),
  /** 首次访问时按需 hydrate；已 fetch 过 / 正在 fetch 不重复 */
  ensureLoaded: (localId: string): void => {
    if (state.byPr.has(localId) || state.loading.has(localId)) return;
    void hydrate(localId);
  },
};

/**
 * 读取指定 PR 的草稿数组。首次访问触发后台 hydrate；hydrate 完成后通过 store
 * subscription 自动 re-render。返回 null 表示还在 loading (UI 可显示加载占位)。
 */
export function useDraftsForPr(localId: string | null | undefined): ReadonlyArray<ReviewDraft> | null {
  const snap = useSyncExternalStore(draftsStore.subscribe, draftsStore.getSnapshot);
  if (!localId) return [];
  if (!snap.byPr.has(localId)) {
    // 副作用：触发 hydrate (内部去重)；调用方下次 render 拿到非 null
    draftsStore.ensureLoaded(localId);
    return null;
  }
  return snap.byPr.get(localId)!;
}

/**
 * 在 App 顶层 useEffect 调用一次。订阅 `drafts:changed` 事件，main 写盘后
 * renderer 自动同步。返回 cleanup 函数。
 */
export function wireDraftsStore(): () => void {
  return subscribe('drafts:changed', (ev) => {
    // 只重拉本地已有 (其他 PR 的草稿先不动，省 IPC 往返)
    if (state.byPr.has(ev.localId) || state.loading.has(ev.localId)) {
      void draftsStore.refresh(ev.localId);
    }
  });
}
