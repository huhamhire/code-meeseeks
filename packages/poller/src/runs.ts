import type {
  Finding,
  ReviewRun,
  ReviewRunFailureReason,
  ReviewRunFile,
  ReviewRunStatus,
  ReviewRunTool,
  TokenUsage,
} from '@meebox/shared';
import type { PrAgentStrategy } from '@meebox/shared';
import type { StateStore } from '@meebox/state-store';

/**
 * runs land at `prs/<localId>/runs/<runId>.json`: together with meta.json /
 * comments.json under the same PR directory; when the PR leaves, deleteDir wipes
 * the whole tree.
 *
 * localId is now the 12-hex from prHashId (`pr-hash-id.ts`), with no path-unsafe
 * characters, so no further sanitize is needed.
 */
function runKey(prLocalId: string, runId: string): string {
  return `prs/${prLocalId}/runs/${runId}`;
}

/**
 * Chronological id, format `yyyymmdd-HHmmss-mmm`. Lexicographic filename order is
 * time order, so listing just reverses to get newest first without reading any
 * file content.
 */
export function makeRunId(now: Date = new Date()): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-` +
    `${pad(now.getMilliseconds(), 3)}`
  );
}

export interface StartReviewRunInput {
  prLocalId: string;
  tool: ReviewRunTool;
  prAgentVersion: string;
  strategy: PrAgentStrategy;
  /** The question for the /ask tool; leave empty for other tools */
  question?: string;
  /**
   * Externally pre-allocated runId (optional). The pr-agent run queue assigns the
   * id at enqueue time (used for cancel(runId) references), and carries the same id
   * through to the actual start, avoiding a mismatch between the enqueue id and the
   * persisted id.
   */
  id?: string;
  /**
   * The LLM model id used by this run (with provider prefix, e.g. `openai/qwen-plus`).
   * When unspecified, run.model is left empty and the UI naturally shows no model chip
   */
  model?: string;
  /** Re-review reference: when this /ask is a re-review of a finding, record the referenced source finding (forward link). */
  referencedFinding?: ReviewRun['referencedFinding'];
  /** Trigger origin: user (manual) / agent (orchestration dispatch). Used for the ChatPane command echo bubble; omitted means no echo. */
  origin?: ReviewRun['origin'];
  /** Single-commit review scope (parent..sha); omitted = full PR scope. Persisted for the result card's scope badge. */
  scope?: ReviewRun['scope'];
}

/** Write the initial running state; callers must start before invoking pr-agent. */
export async function startReviewRun(
  stateStore: StateStore,
  input: StartReviewRunInput,
  now: () => Date = () => new Date(),
): Promise<ReviewRun> {
  const at = now();
  const run: ReviewRun = {
    id: input.id ?? makeRunId(at),
    prLocalId: input.prLocalId,
    tool: input.tool,
    question: input.question,
    prAgentVersion: input.prAgentVersion,
    strategy: input.strategy,
    model: input.model,
    referencedFinding: input.referencedFinding,
    origin: input.origin,
    scope: input.scope,
    status: 'running',
    startedAt: at.toISOString(),
  };
  await stateStore.write<ReviewRunFile>(runKey(run.prLocalId, run.id), {
    schema_version: 1,
    run,
  });
  return run;
}

export interface FinishReviewRunPatch {
  status: ReviewRunStatus;
  finishedAt: string;
  durationMs: number;
  exitCode?: number;
  errorReason?: ReviewRunFailureReason;
  errorMessage?: string;
  stdout?: string;
  stderr?: string;
  /** Structured findings parsed in M3-B2 */
  findings?: Finding[];
  /** Summary for the UI list display */
  summary?: string;
  /** Actual LLM token usage for this run (accumulated, from litellm callback) */
  tokenUsage?: TokenUsage;
  /** Re-review verdict (parsed from the `<verdict>` in re-review /ask output); left empty when not a re-review / not given */
  askVerdict?: ReviewRun['askVerdict'];
}

/**
 * Merge the patch into an existing run and rewrite the file. Returns null when the
 * file does not exist (does not rebuild an empty record, to avoid finishReviewRun
 * silently succeeding after startReviewRun failed).
 */
export async function finishReviewRun(
  stateStore: StateStore,
  prLocalId: string,
  runId: string,
  patch: FinishReviewRunPatch,
): Promise<ReviewRun | null> {
  const file = await stateStore.read<ReviewRunFile>(runKey(prLocalId, runId));
  if (!file) return null;
  const next: ReviewRun = { ...file.run, ...patch };
  await stateStore.write<ReviewRunFile>(runKey(prLocalId, runId), {
    schema_version: 1,
    run: next,
  });
  return next;
}

export async function getReviewRun(
  stateStore: StateStore,
  prLocalId: string,
  runId: string,
): Promise<ReviewRun | null> {
  const file = await stateStore.read<ReviewRunFile>(runKey(prLocalId, runId));
  return file?.run ?? null;
}

/**
 * List a PR's run history. Returns in **reverse** startedAt order (newest first).
 *
 * runId is itself a chronological lexicographic id (`yyyymmdd-HHmmss-mmm`), so
 * ascending filename order = ascending time order, no need to read the file body
 * for the startedAt field.
 *
 * Pagination (for ChatPane scroll-up lazy loading):
 * - `opts.beforeId` returns only entries **earlier** than this runId (strictly less than); omitted = no upper bound
 * - `opts.limit` truncates to N entries; omitted = no limit
 * - locate the page without reading files: first sort keys lexicographically +
 *   filter + slice, then batch read, avoiding a full-table scan on a large store
 */
/**
 * Clear all run history records for a PR (only that PR; deletes `prs/<localId>/runs/*`). Returns the number deleted.
 * A running run's persisted record is deleted too, but finishReviewRun rewrites it on completion → does not affect the in-progress run.
 */
export async function clearReviewRunsForPr(
  stateStore: StateStore,
  prLocalId: string,
): Promise<number> {
  const prefix = `prs/${prLocalId}/runs`;
  const keys: string[] = [];
  for await (const k of stateStore.list(prefix)) keys.push(k);
  for (const k of keys) await stateStore.delete(k);
  return keys.length;
}

/** Delete a single run record by id. Returns whether a record existed before deletion. */
export async function deleteReviewRun(
  stateStore: StateStore,
  prLocalId: string,
  runId: string,
): Promise<boolean> {
  const key = runKey(prLocalId, runId);
  const existed = (await stateStore.read<ReviewRunFile>(key)) != null;
  await stateStore.delete(key);
  return existed;
}

export async function listReviewRunsForPr(
  stateStore: StateStore,
  prLocalId: string,
  opts: { limit?: number; beforeId?: string } = {},
): Promise<ReviewRun[]> {
  const prefix = `prs/${prLocalId}/runs`;
  const keys: string[] = [];
  for await (const k of stateStore.list(prefix)) keys.push(k);
  keys.sort().reverse(); // newest first by runId
  let filtered = keys;
  if (opts.beforeId) {
    // key looks like `prs/<localId>/runs/<runId>`, compare the last segment
    const before = opts.beforeId;
    filtered = keys.filter((k) => {
      const last = k.slice(k.lastIndexOf('/') + 1);
      return last < before;
    });
  }
  const page = opts.limit !== undefined ? filtered.slice(0, opts.limit) : filtered;
  const out: ReviewRun[] = [];
  for (const k of page) {
    const file = await stateStore.read<ReviewRunFile>(k);
    if (file) out.push(file.run);
  }
  return out;
}

/**
 * Whether the PR already has valid /describe or /review output (succeeded, or running). Used for AutoPilot admission:
 * once a session has describe/review output (manual or automatic), it is deemed already reviewed and not auto-triggered again, avoiding duplicate review.
 * Failed / cancelled runs do not count (no valid result produced), and can still trigger.
 */
export async function hasReviewOutput(stateStore: StateStore, prLocalId: string): Promise<boolean> {
  const runs = await listReviewRunsForPr(stateStore, prLocalId);
  return runs.some(
    (r) =>
      (r.tool === 'describe' || r.tool === 'review') &&
      (r.status === 'succeeded' || r.status === 'running'),
  );
}
