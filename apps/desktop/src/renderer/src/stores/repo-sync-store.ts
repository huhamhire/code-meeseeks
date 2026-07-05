import { useSyncExternalStore } from 'react';
import type { SyncProgressEvent } from '@meebox/shared';
import { subscribe } from '../api';

/**
 * Cross-component shared state of the currently active repo sync.
 *
 * Data source: main's `sync:progress` event stream (each repo's start/progress/done/error).
 * One record per repo: start → enters active, progress updates stage + percent, done/error removes it.
 *
 * UI usage: StatusBar displays the first entry from `getActive()`; when there is no active entry the chip is hidden and takes no space.
 * Multiple repos may be queued at the same time (RepoMirrorManager is already a global single-queue serial), and the store keeps them all
 * to allow a "N more queued" extension; the first version only displays the first entry.
 */
export interface RepoSyncState {
  /** repoKey ("host/group/repo") → current stage snapshot */
  active: ReadonlyMap<string, RepoSyncSnapshot>;
}

export interface RepoSyncSnapshot {
  /** From sync:progress.repo, "host/projectKey/repoSlug" */
  repo: string;
  /** simple-git stage name (compressing / receiving / resolving / ...); may be empty at start */
  stage?: string;
  /** 0-100; filled during the progress stage, usually already at 100 on done */
  percent?: number;
  /** For the hover tooltip / troubleshooting */
  message?: string;
  /** Timestamp of entering active, used for UI ordering / "held for X seconds" display */
  startedAt: number;
}

let state: RepoSyncState = { active: new Map() };
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

function setActive(next: ReadonlyMap<string, RepoSyncSnapshot>): void {
  state = { active: next };
  notify();
}

function handleEvent(ev: SyncProgressEvent, nowMs: number): void {
  const next = new Map(state.active);
  if (ev.phase === 'done' || ev.phase === 'error') {
    next.delete(ev.repo);
  } else {
    const prev = next.get(ev.repo);
    next.set(ev.repo, {
      repo: ev.repo,
      stage: ev.stage ?? prev?.stage,
      percent: ev.percent ?? prev?.percent,
      message: ev.message ?? prev?.message,
      startedAt: prev?.startedAt ?? nowMs,
    });
  }
  setActive(next);
}

export const repoSyncStore = {
  getSnapshot: (): RepoSyncState => state,
  subscribe: (cb: () => void): (() => void) => {
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  },
  /** For testing / debugging: feed in an event directly */
  handleEvent,
};

export function useRepoSyncStore(): RepoSyncState {
  return useSyncExternalStore(repoSyncStore.subscribe, repoSyncStore.getSnapshot);
}

/**
 * Wire the IPC sync:progress event to the store. Call once in a top-level App useEffect.
 * Date.now() is read locally only when an event occurs, keeping the store itself pure.
 */
export function wireRepoSyncStore(): () => void {
  return subscribe('sync:progress', (ev) => {
    handleEvent(ev, Date.now());
  });
}
