import type { FindingClosure, FindingClosuresFile } from '@meebox/shared';
import type { StateStore } from '@meebox/state-store';

/**
 * `state/prs/<localId>/findingClosures.json` 的 KV key。与 per-PR 目录布局一致，PR 退场时整树清掉，
 * 无需单独 evict。复评 /ask「取代 / 撤销」原 finding 时记一条关闭关系——独立于本地草稿语义，仅作用于
 * ChatPane finding 卡片的关闭态 + 与复评卡片的双向互链。
 */
function closuresKey(prLocalId: string): string {
  return `prs/${prLocalId}/findingClosures`;
}

/** 读取关闭关系；文件缺失返回空数组。 */
export async function listFindingClosures(
  store: StateStore,
  prLocalId: string,
): Promise<FindingClosure[]> {
  const file = await store.read<FindingClosuresFile>(closuresKey(prLocalId));
  return file?.closures ?? [];
}

async function writeFindingClosures(
  store: StateStore,
  prLocalId: string,
  closures: FindingClosure[],
): Promise<void> {
  await store.write<FindingClosuresFile>(closuresKey(prLocalId), {
    schema_version: 1,
    closures,
  });
}

/**
 * 记一条关闭关系（按 (runId, findingId) 标识源 finding）。同一源 finding 已有关闭关系时**覆盖**
 * （以最近一次复评为准），避免重复堆积。createdAt 由本函数生成。
 */
export async function addFindingClosure(
  store: StateStore,
  prLocalId: string,
  input: Omit<FindingClosure, 'createdAt'>,
  now: () => Date = () => new Date(),
): Promise<FindingClosure> {
  const all = await listFindingClosures(store, prLocalId);
  const closure: FindingClosure = { ...input, createdAt: now().toISOString() };
  const next = all.filter((c) => !(c.runId === input.runId && c.findingId === input.findingId));
  next.push(closure);
  await writeFindingClosures(store, prLocalId, next);
  return closure;
}

/** 撤销一条关闭关系（按源 finding 标识）。不存在则 no-op、不抛错。 */
export async function removeFindingClosure(
  store: StateStore,
  prLocalId: string,
  runId: string,
  findingId: string,
): Promise<void> {
  const all = await listFindingClosures(store, prLocalId);
  const filtered = all.filter((c) => !(c.runId === runId && c.findingId === findingId));
  if (filtered.length === all.length) return;
  await writeFindingClosures(store, prLocalId, filtered);
}
