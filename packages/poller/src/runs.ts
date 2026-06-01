import type {
  Finding,
  ReviewRun,
  ReviewRunFailureReason,
  ReviewRunFile,
  ReviewRunStatus,
  ReviewRunTool,
} from '@pr-pilot/shared';
import type { PrAgentStrategy } from '@pr-pilot/shared';
import type { StateStore } from '@pr-pilot/state-store';

/**
 * `<connectionId>:<remoteId>` 形态的 PR localId 在 Windows 文件名里不合法（冒号
 * 是保留符）。文件路径用此函数清洗；查询 PR 本体仍走原 localId，互不冲突。
 */
export function sanitizePrLocalIdForPath(localId: string): string {
  return localId.replace(/[:/\\]/g, '--');
}

function runKey(prLocalId: string, runId: string): string {
  return `runs/${sanitizePrLocalIdForPath(prLocalId)}/${runId}`;
}

/**
 * 时序 id，格式 `yyyymmdd-HHmmss-mmm`。按文件名字典序即时间序，列出时直接
 * 倒序排即可拿到 newest first，无需读所有文件内容。
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
}

/** 写入初始 running 状态；调用方在 pr-agent 调用前必须先 start。 */
export async function startReviewRun(
  stateStore: StateStore,
  input: StartReviewRunInput,
  now: () => Date = () => new Date(),
): Promise<ReviewRun> {
  const at = now();
  const run: ReviewRun = {
    id: makeRunId(at),
    prLocalId: input.prLocalId,
    tool: input.tool,
    prAgentVersion: input.prAgentVersion,
    strategy: input.strategy,
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
  /** M3-B2 解析得到的结构化 findings */
  findings?: Finding[];
  /** UI 列表展示用的概要 */
  summary?: string;
}

/**
 * Merge patch 到已存在的 run，重写文件。文件不存在返回 null（不重建空记录，
 * 避免 startReviewRun 失败后 finishReviewRun 静默成功）。
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
 * 列出一个 PR 的所有 run，按 startedAt 倒序（newest first）。
 * 借助文件名是时序 id 这一点，列名后按字典序倒排即可，无需读文件内容做排序。
 */
export async function listReviewRunsForPr(
  stateStore: StateStore,
  prLocalId: string,
): Promise<ReviewRun[]> {
  const prefix = `runs/${sanitizePrLocalIdForPath(prLocalId)}`;
  const keys: string[] = [];
  for await (const k of stateStore.list(prefix)) keys.push(k);
  keys.sort().reverse();
  const out: ReviewRun[] = [];
  for (const k of keys) {
    const file = await stateStore.read<ReviewRunFile>(k);
    if (file) out.push(file.run);
  }
  return out;
}
