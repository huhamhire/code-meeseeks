import type { LocalPrStatus, StoredPullRequest } from '@meebox/shared';
import type { StateStore } from '@meebox/state-store';
import type { PrIdentity } from './pr-hash-id.js';

/**
 * `state/prs/index.json` 唯一负责"哪些 hash localId 当前已知 + 状态字段"，
 * 用作快速列表 / 退场判定 / 软删跟踪。完整 PR 元数据 (title / refs / reviewers
 * 等) 落在 `prs/<localId>/meta.json`。
 */
export interface PrIndexEntry {
  identity: PrIdentity;
  /** 远端 PR.updatedAt 镜像，poll 比对用 */
  updatedAt: string;
  /** 首次被本机 poll 发现时间 */
  discoveredAt: string;
  /** 最近一次仍在远端列表里出现的时间 */
  lastSeenAt: string;
  /**
   * 软删时间戳：PR 在远端从 reviewer pending 列表消失 (merged / declined / 自己
   * 不再是 reviewer) → 设为本次 poll 的 now。重新出现时清回 null (反向恢复)。
   * 距 archivedAt 超过 PURGE_GRACE_MS 后才真正 rm -r 目录。
   *
   * 软删窗口期内 UI 不展示 (listStoredPullRequests 过滤掉)，但 runs 历史 / 缓存
   * 都保留 —— 用户万一回头查可以恢复。
   */
  archivedAt: string | null;
}

export interface PrIndexFile {
  schema_version: 1;
  /** hash localId → entry。Object 而非 Array：lookup O(1) + JSON 体积更小 */
  prs: Record<string, PrIndexEntry>;
}

export interface PrMetaFile {
  schema_version: 1;
  pr: StoredPullRequest;
}

/** 软删保留期：1 周。超过此时长的 archived 条目下一次 poll 时被 hard purge */
export const PURGE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export const PR_INDEX_KEY = 'prs/index';

export function prMetaKey(localId: string): string {
  return `prs/${localId}/meta`;
}

export function prDirKey(localId: string): string {
  return `prs/${localId}`;
}

export async function readPrIndex(store: StateStore): Promise<PrIndexFile | null> {
  return store.read<PrIndexFile>(PR_INDEX_KEY);
}

export async function writePrIndex(store: StateStore, file: PrIndexFile): Promise<void> {
  await store.write(PR_INDEX_KEY, file);
}

export async function readPrMeta(
  store: StateStore,
  localId: string,
): Promise<PrMetaFile | null> {
  return store.read<PrMetaFile>(prMetaKey(localId));
}

export async function writePrMeta(
  store: StateStore,
  localId: string,
  pr: StoredPullRequest,
): Promise<void> {
  await store.write<PrMetaFile>(prMetaKey(localId), { schema_version: 1, pr });
}

/**
 * 列出当前**活跃** (非软删) 的 PR。
 *
 * 实现：先读索引 → 过滤掉 archivedAt 非空的 → 逐个读 meta.json。索引里没有但目录
 * 还在的 meta 视为孤儿，跳过 (poll 阶段会清掉)。
 */
export async function listStoredPullRequests(
  store: StateStore,
): Promise<StoredPullRequest[]> {
  const index = await readPrIndex(store);
  if (!index) return [];
  const out: StoredPullRequest[] = [];
  for (const [localId, entry] of Object.entries(index.prs)) {
    if (entry.archivedAt) continue;
    const meta = await readPrMeta(store, localId);
    if (meta) out.push(meta.pr);
  }
  return out;
}

/**
 * 覆写指定 PR 的 localStatus。调用方 (IPC) 通常先 PUT 到 Bitbucket 成功后再调本函数，
 * 让本地立即反映新状态；下一轮 poll 会从 Bitbucket 拿到同样的值，不会产生抖动。
 *
 * 找不到 meta 返回 null (PR 已退场 / 从未存在)。
 */
export async function setLocalStatus(
  store: StateStore,
  localId: string,
  localStatus: LocalPrStatus,
): Promise<StoredPullRequest | null> {
  const meta = await readPrMeta(store, localId);
  if (!meta) return null;
  const next: StoredPullRequest = { ...meta.pr, localStatus };
  await writePrMeta(store, localId, next);
  return next;
}
