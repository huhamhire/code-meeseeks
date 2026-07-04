import { useEffect, useSyncExternalStore } from 'react';
import type { ReviewDraft } from '@meebox/shared';
import { invoke, subscribe } from '../api';

/**
 * Cross-component shared draft pool. Each PR's drafts are stored separately (keyed
 * by localId), avoiding wiping another PR's drafts when switching PRs.
 *
 * Data flow:
 *   main IPC `drafts:create/update/delete` → write to disk + broadcast `drafts:changed` →
 *   this store receives the event → calls `drafts:list` to re-pull → notify subscribers
 *
 * ChatPane / DiffView both read via `useDraftsForPr(localId)`, following the same
 * pattern as chatRunStore / repoSyncStore.
 */
export interface DraftsStoreState {
  /** localId → all drafts of that PR. A PR not yet pulled is missing its key (the UI's first access triggers hydrate) */
  byPr: ReadonlyMap<string, ReadonlyArray<ReviewDraft>>;
  /** Set of localIds currently being fetched, to avoid duplicate triggers */
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
    // Fail silently; the UI sees empty drafts, and a retry is triggered by the next hydrate
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
  /** Force a re-pull (triggered by the drafts:changed event) */
  refresh: (localId: string): Promise<void> => hydrate(localId),
  /** Hydrate on demand on first access; skip if already fetched / currently fetching */
  ensureLoaded: (localId: string): void => {
    if (state.byPr.has(localId) || state.loading.has(localId)) return;
    void hydrate(localId);
  },
};

/**
 * Read the draft array of a given PR. First access triggers a background hydrate;
 * after hydrate completes it auto re-renders via the store subscription. Returns
 * null to indicate still loading (the UI can show a loading placeholder).
 */
export function useDraftsForPr(localId: string | null | undefined): ReadonlyArray<ReviewDraft> | null {
  const snap = useSyncExternalStore(draftsStore.subscribe, draftsStore.getSnapshot);
  // Hydrate on demand on first access. **Must go in an effect, never trigger during the render phase**: ensureLoaded →
  // markLoading → notify() synchronously notifies all subscribers, and calling it during render means "updating component B
  // that also subscribes to this store while rendering component A", for which React reports "Cannot update a component while
  // rendering a different component". An effect runs after commit, so notify lands outside rendering and the warning is gone.
  useEffect(() => {
    if (localId) draftsStore.ensureLoaded(localId);
  }, [localId]);
  if (!localId) return [];
  if (!snap.byPr.has(localId)) return null;
  return snap.byPr.get(localId)!;
}

/**
 * Call once in a top-level App useEffect. Subscribes to the `drafts:changed` event;
 * after main writes to disk, the renderer auto-syncs. Returns a cleanup function.
 */
export function wireDraftsStore(): () => void {
  return subscribe('drafts:changed', (ev) => {
    // Only re-pull what's already local (leave other PRs' drafts untouched, saving IPC round-trips)
    if (state.byPr.has(ev.localId) || state.loading.has(ev.localId)) {
      void draftsStore.refresh(ev.localId);
    }
  });
}
