import { useEffect, useSyncExternalStore } from 'react';
import type { FindingClosure } from '@meebox/shared';
import { invoke, subscribe } from '../api';

/**
 * 跨组件共享的 finding 关闭关系池（复评 /ask 取代/撤销原 finding 时建立）。每个 PR 独立一份，与
 * draftsStore 同模。数据流：main `findingClosures:create/delete` → 写盘 + 广播 `findingClosures:changed`
 * → 本 store 重拉 → notify。`useFindingClosuresForPr(localId)` 供 FindingCard / RunResultView 读，
 * 据 (runId, findingId) 反查某条 finding 是否已被复评关闭。
 */
export interface FindingClosuresStoreState {
  byPr: ReadonlyMap<string, ReadonlyArray<FindingClosure>>;
  loading: ReadonlySet<string>;
}

let state: FindingClosuresStoreState = { byPr: new Map(), loading: new Set() };
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

function setForPr(localId: string, closures: ReadonlyArray<FindingClosure>): void {
  const nextMap = new Map(state.byPr);
  nextMap.set(localId, closures);
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
    const list = await invoke('findingClosures:list', { localId });
    setForPr(localId, list);
  } catch {
    setForPr(localId, []);
  }
}

export const findingClosuresStore = {
  getSnapshot: (): FindingClosuresStoreState => state,
  subscribe: (cb: () => void): (() => void) => {
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  },
  refresh: (localId: string): Promise<void> => hydrate(localId),
  ensureLoaded: (localId: string): void => {
    if (state.byPr.has(localId) || state.loading.has(localId)) return;
    void hydrate(localId);
  },
};

/** 读取指定 PR 的关闭关系数组（null = loading）。首次访问触发后台 hydrate。 */
export function useFindingClosuresForPr(
  localId: string | null | undefined,
): ReadonlyArray<FindingClosure> | null {
  const snap = useSyncExternalStore(
    findingClosuresStore.subscribe,
    findingClosuresStore.getSnapshot,
  );
  // 同 draftsStore：hydrate 放 effect，避免 render 期 notify 触发跨组件更新告警。
  useEffect(() => {
    if (localId) findingClosuresStore.ensureLoaded(localId);
  }, [localId]);
  if (!localId) return [];
  if (!snap.byPr.has(localId)) return null;
  return snap.byPr.get(localId)!;
}

/** App 顶层调用一次，订阅 `findingClosures:changed` 自动同步。 */
export function wireFindingClosuresStore(): () => void {
  return subscribe('findingClosures:changed', (ev) => {
    if (state.byPr.has(ev.localId) || state.loading.has(ev.localId)) {
      void findingClosuresStore.refresh(ev.localId);
    }
  });
}
