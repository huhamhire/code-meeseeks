import type {
  AgentStep,
  AgentTodoItem,
  PollNotificationKind,
  PollResult,
  SyncProgressEvent,
  UpdateCheckResult,
} from '@meebox/shared';
import type { PragentRunInfo } from './common.js';

/** Broadcast to renderer after a poller tick completes, to update the "last sync" display. */
export interface PollTickEvent {
  /** tick completion time, ISO */
  at: string;
  result: PollResult;
}

/**
 * Streams whole lines of stdout / stderr during a pr-agent run. Renderer uses it to display
 * in real time in ChatPane or the log area. Many per run; not sent after the run ends.
 */
export interface PragentRunProgressEvent {
  runId: string;
  line: string;
  stream: 'stdout' | 'stderr';
}

/** main → renderer push events. Renderer subscribes via window.api.subscribe. */
export interface IpcEvents {
  'sync:progress': SyncProgressEvent;
  'poll:tick': PollTickEvent;
  'pragent:runProgress': PragentRunProgressEvent;
  /**
   * Draft change broadcast: triggered when a PR's drafts.json is added/deleted/modified, or by the
   * "re-ingest" cleanup on /review completion. Renderer refetches the drafts list (filtered per localId).
   */
  'drafts:changed': { localId: string };
  /** finding closure relation change broadcast: triggered after a re-review /ask supersedes/revokes the original finding (or revokes a closure); renderer refetches closure relations. */
  'findingClosures:changed': { localId: string };
  /** Broadcast after a comment reply / status change; renderer components (CommentsPanel / DiffView inline) refetch */
  'comments:changed': { localId: string };
  /**
   * Queue change broadcast: triggered by active add/remove or waiting add/remove. Renderer syncs the
   * chat-pane running UI + StatusBar queue chip. `active` is the list of currently concurrent running runs
   * (length ≤ max_concurrency).
   */
  'pragent:queueChanged': {
    active: PragentRunInfo[];
    waiting: PragentRunInfo[];
  };
  /** Pushed when a new version is detected at startup (only sent when hasUpdate=true); renderer prompts accordingly. */
  'app:updateAvailable': UpdateCheckResult;
  /** Streams agent orchestration steps: sent whenever an AgentStep is produced; renderer renders it in real time. */
  'agent:stepProgress': { sessionId: string; prLocalId: string; step: AgentStep };
  /**
   * A PR's multi-turn conversation has a new persisted message (e.g. the "review summary" appended by a background
   * AutoPilot review at completion). If renderer has that PR open it reloads the conversation, so the background-produced
   * summary card appears immediately (manual review reloads itself after the invoke returns, not relying on this event).
   */
  'agent:conversationChanged': { prLocalId: string };
  /**
   * Pushed when the planning agent's "plan (todo)" updates: sent whenever the model produces / updates a plan; renderer refreshes the plan panel in real time.
   * The plan is persisted with the session (session.todo), hydrated via agent:getSession after switching PR / restart.
   */
  'agent:planUpdated': { prLocalId: string; todo: AgentTodoItem[] };
  /**
   * Pushed when the set of PRs owned by running (thinking or dispatching tools) orchestration agents changes: manual `agent:run` / `agent:ask`
   * and AutoPilot background reviews are both counted. Renderer shows a "running" indicator on PR list items—covering the **pure thinking phase**
   * (when there is no active tool run), filling the gap where the thinking state lacks a running marker if only the run queue is watched.
   */
  'agent:runningChanged': { prLocalIds: string[] };
  /**
   * A PR's review status is cleared (clearing execution history also clears the AutoPilot ledger). Renderer immediately clears
   * that PR's review-suggestion ★ badge in the PR list, avoiding stale review status lingering after clearing (no need to wait for the next poll to refetch the ledger).
   */
  'agent:reviewStatusCleared': { prLocalId: string };
  /**
   * Navigation intent pushed by main after the user clicks a system notification; renderer selects and locates the target PR:
   * - `anchor` non-null (inline comment) → switch to the Diff tab and jump to that file line;
   * - `anchor` is null and kind is mention/reply (summary comment) → switch to the "activity" conversation tab;
   * - kind is new_pr → just select that PR.
   * When the target is not in the current active list (archived / retired) renderer ignores it.
   */
  'notification:activate': {
    localId: string;
    kind: PollNotificationKind;
    anchor: { path: string; line: number; side: 'old' | 'new' } | null;
  };
}

export type IpcEventName = keyof IpcEvents;
