import { useEffect, useSyncExternalStore } from 'react';
import type { FindingClosure } from '@meebox/shared';
import { invoke, subscribe } from '../api';

/**
 * Cross-component shared finding-closure relation pool (established when a re-review /ask supersedes/revokes the original
 * finding). One separate copy per PR, same pattern as draftsStore. Data flow: main `findingClosures:create/delete` → write
 * to disk + broadcast `findingClosures:changed` → this store re-pulls → notify. `useFindingClosuresForPr(localId)` is read
 * by FindingCard / RunResultView to look up, by (runId, findingId), whether a given finding has been closed by re-review.
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

/** Read the closure-relation array of a given PR (null = loading). First access triggers a background hydrate. */
export function useFindingClosuresForPr(
  localId: string | null | undefined,
): ReadonlyArray<FindingClosure> | null {
  const snap = useSyncExternalStore(
    findingClosuresStore.subscribe,
    findingClosuresStore.getSnapshot,
  );
  // Same as draftsStore: put hydrate in an effect, avoiding a render-phase notify triggering the cross-component update warning.
  useEffect(() => {
    if (localId) findingClosuresStore.ensureLoaded(localId);
  }, [localId]);
  if (!localId) return [];
  if (!snap.byPr.has(localId)) return null;
  return snap.byPr.get(localId)!;
}

/** Call once at the top level of App; subscribes to `findingClosures:changed` to auto-sync. */
export function wireFindingClosuresStore(): () => void {
  return subscribe('findingClosures:changed', (ev) => {
    if (state.byPr.has(ev.localId) || state.loading.has(ev.localId)) {
      void findingClosuresStore.refresh(ev.localId);
    }
  });
}
