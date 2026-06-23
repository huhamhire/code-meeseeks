import type { StateStore } from '@meebox/state-store';

/**
 * PR diff 基准（merge-base）固化文件。落在 `prs/<localId>/diff-base.json`。
 *
 * **为什么固化**：PR diff 的语义基准应是「源分支自目标分支分叉处」= `merge-base(target, head)`，
 * 而非目标分支当前 tip（`targetRef.sha`，会随别的 PR 合入而前移）。
 * - 变更文件列表 / 改动行用三点 diff（`base...head`），已隐式按 merge-base 算，对目标前移稳定；
 * - 但**文件内容**（Monaco 左栏）若按 `targetRef.sha` 读，编辑器实际是两点对比，目标漂移后别的 PR
 *   的改动会以「倒挂/撤回」形式串进来。固化 merge-base 后，内容 / 列表 / 计数 / blame / pr-agent
 *   一律以它为 base，编辑器即真三点、对目标漂移稳定，评论 / finding 行锚点也有了固定参照。
 *
 * **失效**：`head`（`sourceRef.sha`）被 rebase 致固化 base 不再是其祖先时重算；源分支把
 * 当前目标分支 merge 进来时也重算，避免旧分叉点把 merge 带来的目标分支改动算进 PR diff。
 * 源分支正常 push（head 仅前进）不失效，base 仍锚在分叉点。
 *
 * 它是**本地派生缓存**、非平台元数据，独立成文件，poller 重写 meta.json 时不触碰。
 */
export interface DiffBaseCacheFile {
  schema_version: 1;
  /** 固化的 merge-base sha，作为 diff/内容/计数/blame/pr-agent 的统一 base */
  base_sha: string;
  /** 算这个 base 时对应的 head（sourceRef.sha），便于排障与人工核对 */
  head_sha: string;
  /** 计算完成的 ISO 时间 */
  computed_at: string;
}

export interface DiffBaseCacheReuseInput {
  cachedBaseSha: string;
  targetSha: string;
  headSha: string;
  isAncestor: (ancestor: string, descendant: string) => Promise<boolean>;
}

export async function isDiffBaseCacheReusable(input: DiffBaseCacheReuseInput): Promise<boolean> {
  const { cachedBaseSha, targetSha, headSha, isAncestor } = input;
  if (!(await isAncestor(cachedBaseSha, headSha))) return false;
  // 源分支 merge 目标分支后，target 会成为 head 的祖先；继续用旧分叉点会把这次 merge
  // 带入的目标分支改动也算进 PR diff，必须重算到新的 merge-base（通常就是 target）。
  if (targetSha !== cachedBaseSha && (await isAncestor(targetSha, headSha))) return false;
  return true;
}

export function diffBaseCacheKey(localId: string): string {
  return `prs/${localId}/diff-base`;
}

export async function readDiffBaseCache(
  store: StateStore,
  localId: string,
): Promise<DiffBaseCacheFile | null> {
  return store.read<DiffBaseCacheFile>(diffBaseCacheKey(localId));
}

export async function writeDiffBaseCache(
  store: StateStore,
  localId: string,
  data: { base_sha: string; head_sha: string; computed_at: string },
): Promise<void> {
  await store.write<DiffBaseCacheFile>(diffBaseCacheKey(localId), {
    schema_version: 1,
    ...data,
  });
}
