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
 * runs 落在 `prs/<localId>/runs/<runId>.json`：跟 meta.json / comments.json 一起
 * 在同一个 PR 目录下，PR 退场时 deleteDir 整棵清掉。
 *
 * localId 现是 prHashId 出来的 12 位 hex (`pr-hash-id.ts`)，无路径不安全字符，
 * 不需要再 sanitize。
 */
function runKey(prLocalId: string, runId: string): string {
  return `prs/${prLocalId}/runs/${runId}`;
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
  /** /ask 工具的问题；其他 tool 留空 */
  question?: string;
  /**
   * 外部预分配的 runId (可选)。pr-agent run queue 在入队时就分配 id (用于
   * cancel(runId) 引用)，到真正 start 时把同一 id 沿用下来，避免入队 id 跟
   * 落盘 id 不一致。
   */
  id?: string;
  /**
   * 本次 run 使用的 LLM model id (含 provider 前缀，如 `openai/qwen-plus`)。
   * 未指定时 run.model 留空，UI 自然不展示模型 chip
   */
  model?: string;
  /** 是否由 AutoPilot 后台自动评审派发；落盘供 UI 在 run 卡片打机器人 chip。 */
  autopilot?: boolean;
}

/** 写入初始 running 状态；调用方在 pr-agent 调用前必须先 start。 */
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
    status: 'running',
    startedAt: at.toISOString(),
    ...(input.autopilot ? { autopilot: true } : {}),
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
  /** 本次 run 的真实 LLM token 用量（累加，来自 litellm callback） */
  tokenUsage?: TokenUsage;
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
 * 列出一个 PR 的 run 历史。按 startedAt **倒序** (newest first) 返回。
 *
 * runId 本身是时序字典序 (`yyyymmdd-HHmmss-mmm`)，所以文件名升序排 = 时间升序排，
 * 不必读 file body 拿 startedAt 字段。
 *
 * 分页（用于 ChatPane 向上滚动懒加载）：
 * - `opts.beforeId` 仅返回**更早**于此 runId 的条目（严格小于）；省略 = 不限上界
 * - `opts.limit` 截到 N 条；省略 = 不限
 * - 不读文件就能定位 page：先按 key 字典序排序 + 过滤 + 切片，再批量读，避免大库
 *   全表扫描
 */
/**
 * 清空某 PR 的全部 run 历史记录（仅该 PR；删 `prs/<localId>/runs/*`）。返回删除条数。
 * 正在跑的 run 其落盘记录也会被删，但跑完时 finishReviewRun 会重新落盘 → 不影响进行中的 run。
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
    // key 形如 `prs/<localId>/runs/<runId>`，取末段比较
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
 * 该 PR 是否已有 /describe 或 /review 的有效产出（已成功，或正在跑）。用于 AutoPilot 准入：
 * 会话中一旦有 describe/review 输出（手动或自动）即判定已评审过，不再自动触发，避免重复评审。
 * 失败 / 取消的 run 不算（未产出有效结果），仍可触发。
 */
export async function hasReviewOutput(stateStore: StateStore, prLocalId: string): Promise<boolean> {
  const runs = await listReviewRunsForPr(stateStore, prLocalId);
  return runs.some(
    (r) =>
      (r.tool === 'describe' || r.tool === 'review') &&
      (r.status === 'succeeded' || r.status === 'running'),
  );
}
