import crypto from 'node:crypto';
import type { DraftsFile, ReviewDraft } from '@pr-pilot/shared';
import type { StateStore } from '@pr-pilot/state-store';

/**
 * `state/prs/<localId>/drafts.json` 的 KV key。跟 ADR-0006 per-PR 目录布局一致，
 * PR 退场时 `deleteDir` 整树清掉，不需要单独 evict 草稿。
 */
function draftsKey(prLocalId: string): string {
  return `prs/${prLocalId}/drafts`;
}

/** 12 hex chars 短 id：跟 PR localId 同套，避免在 UI / 日志里出现两种 id 形态 */
function makeDraftId(): string {
  return crypto.randomBytes(8).toString('hex').slice(0, 12);
}

/** 读取 drafts；文件缺失 (PR 第一次进入草稿流) 返回空数组 */
export async function listDrafts(
  store: StateStore,
  prLocalId: string,
): Promise<ReviewDraft[]> {
  const file = await store.read<DraftsFile>(draftsKey(prLocalId));
  return file?.drafts ?? [];
}

export async function getDraft(
  store: StateStore,
  prLocalId: string,
  draftId: string,
): Promise<ReviewDraft | null> {
  const all = await listDrafts(store, prLocalId);
  return all.find((d) => d.id === draftId) ?? null;
}

/**
 * 写整个 drafts 数组回盘。所有 mutator (create / update / delete /
 * dropPendingFindingDrafts) 都走这条路径，让"读-改-写"原子性靠 StateStore 的
 * tmp + rename 兜底。
 */
async function writeDrafts(
  store: StateStore,
  prLocalId: string,
  drafts: ReviewDraft[],
): Promise<void> {
  await store.write<DraftsFile>(draftsKey(prLocalId), {
    schema_version: 1,
    drafts,
  });
}

/**
 * 创建一条草稿。id / createdAt / updatedAt 由本函数生成；调用方传业务字段。
 * 约定：origin='finding' 时必须带 source；origin='manual' 时不要 source (上层 IPC
 * 已校验)。
 */
export async function createDraft(
  store: StateStore,
  prLocalId: string,
  input: Omit<ReviewDraft, 'id' | 'createdAt' | 'updatedAt' | 'prLocalId'>,
  now: () => Date = () => new Date(),
): Promise<ReviewDraft> {
  const all = await listDrafts(store, prLocalId);
  const nowIso = now().toISOString();
  const draft: ReviewDraft = {
    id: makeDraftId(),
    prLocalId,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...input,
  };
  all.push(draft);
  await writeDrafts(store, prLocalId, all);
  return draft;
}

/**
 * 部分更新。任何字段 patch 都 bump updatedAt。
 *
 * 状态自动跃迁：patch 中含 `body` 且草稿当前 status='pending' → 自动转 'edited'
 * (用户动了原 AI 建议)。显式 patch.status 优先于自动规则。
 *
 * 找不到 draftId 返回 null (调用方按需兜底，不抛错)。
 */
export async function updateDraft(
  store: StateStore,
  prLocalId: string,
  draftId: string,
  patch: Partial<Pick<ReviewDraft, 'body' | 'status' | 'posted_remote_id'>>,
  now: () => Date = () => new Date(),
): Promise<ReviewDraft | null> {
  const all = await listDrafts(store, prLocalId);
  const idx = all.findIndex((d) => d.id === draftId);
  if (idx < 0) return null;
  const cur = all[idx]!;
  // body 改动 + pending → 自动 'edited'；显式 patch.status 优先
  const autoStatus =
    patch.body !== undefined && patch.body !== cur.body && cur.status === 'pending'
      ? 'edited'
      : undefined;
  const next: ReviewDraft = {
    ...cur,
    ...patch,
    status: patch.status ?? autoStatus ?? cur.status,
    updatedAt: now().toISOString(),
  };
  all[idx] = next;
  await writeDrafts(store, prLocalId, all);
  return next;
}

export async function deleteDraft(
  store: StateStore,
  prLocalId: string,
  draftId: string,
): Promise<void> {
  const all = await listDrafts(store, prLocalId);
  const filtered = all.filter((d) => d.id !== draftId);
  if (filtered.length === all.length) return; // no-op，不存在的 id 不抛错
  await writeDrafts(store, prLocalId, filtered);
}

/**
 * /review 完成时的"再摄入"规则 (ADR-0007 §2)：丢弃所有 `pending+finding` 草稿。
 *
 * 保留：status ∈ {edited, posted, rejected} 或 origin='manual' —— 用户已投入的
 * 决断永不被覆盖。
 *
 * 返回被丢弃的草稿数，main 端可以用来给 RunResultView 加 "清理 N 条旧待处理"
 * 反馈 chip。
 */
export async function dropPendingFindingDrafts(
  store: StateStore,
  prLocalId: string,
): Promise<number> {
  const all = await listDrafts(store, prLocalId);
  const kept = all.filter(
    (d) => !(d.status === 'pending' && d.origin === 'finding'),
  );
  const dropped = all.length - kept.length;
  if (dropped === 0) return 0;
  await writeDrafts(store, prLocalId, kept);
  return dropped;
}
