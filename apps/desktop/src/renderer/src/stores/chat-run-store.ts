import { useSyncExternalStore } from 'react';
import type { CodexReviewProgress, PragentRunInfo } from '@meebox/ipc';
import { invoke, subscribe } from '../api';

export type CodexProgressEntry = CodexReviewProgress & { at: number };

/**
 * Cross-ChatPane-instance pr-agent run queue + live stdout cache. Kept in a
 * module-level store rather than React state because: switching PRs unmounts and
 * rebuilds ChatPane, but pr-agent keeps running in the main process and keeps
 * emitting `pragent:runProgress` events — lifting (active, waiting, received
 * lines) above the React tree lets a freshly mounted ChatPane read the correct
 * state immediately.
 *
 * Data is replaced immutably (linesByRunId uses a brand-new Map / array, waiting
 * a new array), pairing with useSyncExternalStore's identity check to trigger a
 * re-render.
 */
export interface ChatRunStoreState {
  /** List of runs currently running concurrently (length ≤ max_concurrency). Empty array means no run is currently running */
  active: ReadonlyArray<PragentRunInfo>;
  /** Queue of runs waiting to execute (FIFO, earlier ones run first). Empty array means nobody is queued */
  waiting: ReadonlyArray<PragentRunInfo>;
  /** Live stdout line cache per run. Key = runId; retained after a run completes until clearLines is called */
  linesByRunId: ReadonlyMap<string, ReadonlyArray<string>>;
  codexProgressByRunId: ReadonlyMap<string, ReadonlyArray<CodexProgressEntry>>;
  /** Set of PR localIds with an orchestrating Agent running (thinking or dispatching tools) — includes the pure-thinking
   *  phase (no active tool run), from the main process's `agent:runningChanged`. The PR list item's "running" indicator
   *  merges in this set on top of the tool queue. */
  agentPrs: ReadonlyArray<string>;
}

let state: ChatRunStoreState = {
  active: [],
  waiting: [],
  linesByRunId: new Map(),
  codexProgressByRunId: new Map(),
  agentPrs: [],
};
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
    a.every((run, i) => {
      const next = b[i];
      return run.runId === next?.runId && run.startedAt === next.startedAt &&
        run.reviewPhase === next.reviewPhase;
    })
  );
}

function setQueue(
  active: ReadonlyArray<PragentRunInfo>,
  waiting: ReadonlyArray<PragentRunInfo>,
): void {
  const sameActive = sameRunList(state.active, active);
  // Skip notifications when queue membership and displayed run state are unchanged.
  if (sameActive && sameRunList(state.waiting, waiting)) return;
  // Globally reclaim stdout cache: clear the lines of any run that left active (completed as success/failure/cancel).
  // Placed at the store layer rather than ChatPane — independent of which PR the user currently has open, avoiding
  // long-lived lines for runs completed on a non-current PR. The deletions merge into the same state update, notifying only once.
  let linesByRunId = state.linesByRunId;
  let codexProgressByRunId = state.codexProgressByRunId;
  if (!sameActive) {
    const nextActiveIds = new Set(active.map((r) => r.runId));
    let nextMap: Map<string, ReadonlyArray<string>> | null = null;
    let nextCodexMap: Map<string, ReadonlyArray<CodexProgressEntry>> | null = null;
    for (const prev of state.active) {
      if (nextActiveIds.has(prev.runId)) continue;
      if (linesByRunId.has(prev.runId)) {
        nextMap ??= new Map(linesByRunId);
        nextMap.delete(prev.runId);
      }
      if (codexProgressByRunId.has(prev.runId)) {
        nextCodexMap ??= new Map(codexProgressByRunId);
        nextCodexMap.delete(prev.runId);
      }
    }
    if (nextMap) linesByRunId = nextMap;
    if (nextCodexMap) codexProgressByRunId = nextCodexMap;
  }
  state = { ...state, active, waiting, linesByRunId, codexProgressByRunId };
  notify();
}

/** Set equality (order-independent): same length and every id is in the old set. Avoids pointless re-renders from broadcast ordering differences. */
function sameIdSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((id) => sa.has(id));
}

function setAgentPrs(ids: ReadonlyArray<string>): void {
  if (sameIdSet(state.agentPrs, ids)) return;
  state = { ...state, agentPrs: ids };
  notify();
}

function appendLine(runId: string, line: string): void {
  const cur = state.linesByRunId.get(runId) ?? [];
  const nextMap = new Map(state.linesByRunId);
  nextMap.set(runId, [...cur, line]);
  state = { ...state, linesByRunId: nextMap };
  notify();
}

function appendCodexProgress(runId: string, entry: CodexProgressEntry): void {
  const history = state.codexProgressByRunId.get(runId) ?? [];
  const summaryCount = history.filter((event) => 'summary' in event).length;
  const next = 'summary' in entry && summaryCount >= 100
    ? history.filter((_, index) => index !== history.findIndex((event) => 'summary' in event))
    : history;
  const codexProgressByRunId = new Map(state.codexProgressByRunId);
  codexProgressByRunId.set(runId, [...next, entry]);
  state = { ...state, codexProgressByRunId };
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
  setAgentPrs,
  appendLine,
  clearLines,
};

export function useChatRunStore(): ChatRunStoreState {
  return useSyncExternalStore(chatRunStore.subscribe, chatRunStore.getSnapshot);
}

/**
 * Wire up the IPC → store data flow. Call once in a top-level App useEffect.
 * - Pull a queue snapshot once at startup as a fallback (UI can still recover after window reload / preload reconnect)
 * - Subscribe to queueChanged events, updating store.active + store.waiting
 * - Subscribe to runProgress events, appending each line to the lines cache of the corresponding runId
 *
 * Returns a cleanup function that unsubscribes everything on App unmount.
 */
export function wireChatRunStore(): () => void {
  let cancelled = false;
  void (async () => {
    try {
      const snap = await invoke('pragent:queue', undefined);
      if (!cancelled) chatRunStore.setQueue(snap.active, snap.waiting);
    } catch {
      // Failing to get the queue at startup is not fatal; events will fill in as a fallback
    }
  })();
  const unsubQueue = subscribe('pragent:queueChanged', (ev) => {
    chatRunStore.setQueue(ev.active, ev.waiting);
  });
  const unsubProgress = subscribe('pragent:runProgress', (ev) => {
    chatRunStore.appendLine(ev.runId, ev.line);
  });
  const unsubCodexProgress = subscribe('codex:runProgress', (ev) => {
    appendCodexProgress(ev.runId, { ...ev.codex, at: ev.at });
  });
  // Set of PRs with an orchestrating Agent running (including the pure-thinking phase): manual run/ask and AutoPilot background review are both counted in.
  const unsubAgentRunning = subscribe('agent:runningChanged', (ev) => {
    chatRunStore.setAgentPrs(ev.prLocalIds);
  });
  return () => {
    cancelled = true;
    unsubQueue();
    unsubProgress();
    unsubCodexProgress();
    unsubAgentRunning();
  };
}
