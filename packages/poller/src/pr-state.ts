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
  /**
   * 「@我 / 回复我」最新评论时间的单调游标（ISO）。poll 在 PR 内容变更（updatedAt 跳变）时拉评论扫描后
   * 取较大值更新；读取时与已读水位 `lastReadAt` 比较得出 mention 未读。由 poll 独占维护（poll 整体重写索引），
   * 与用户的已读水位（另存 read-state.json）解耦，避免 poll 重写索引时把用户操作覆盖掉。
   */
  lastMentionAt?: string;
}

/**
 * 用户对单个 PR 的「已读水位」。独立成 `prs/<localId>/read-state.json` —— **仅** markRead（用户打开 PR）写；
 * poll 周期性重写 index.json 时完全不碰它，从而不会把用户刚推进的水位覆盖回去。未写过 = 用户从未打开该 PR。
 */
export interface PrReadStateFile {
  schema_version: 1;
  /** 用户上次查看时的源分支 head sha；当前 head 与之不同 = 有新 commit = 未读 */
  lastReadHeadSha: string;
  /** 用户上次查看时间（ISO）；晚于此的 @我 / 回复我评论 = 未读 */
  lastReadAt: string;
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

export function prReadStateKey(localId: string): string {
  return `prs/${localId}/read-state`;
}

export async function readPrReadState(
  store: StateStore,
  localId: string,
): Promise<PrReadStateFile | null> {
  return store.read<PrReadStateFile>(prReadStateKey(localId));
}

export async function writePrReadState(
  store: StateStore,
  localId: string,
  data: { lastReadHeadSha: string; lastReadAt: string },
): Promise<void> {
  await store.write<PrReadStateFile>(prReadStateKey(localId), { schema_version: 1, ...data });
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
 * 计算 PR 的「未读」标记（派生，不持久化）。规则：
 * - **从未打开过**（无 read-state）→ 未读：覆盖「新分配 / 请求评审给你」的新到达，以及清空目录 / 全新安装后涌入的 PR。
 * - 打开过之后：源 head 又变（新 commit），或已读时间之后出现「@我 / 回复我」评论（`lastMentionAt > lastReadAt`）→ 未读。
 *
 * 已读水位（read-state）由用户打开 PR 写入。早期开发版不做升级兼容——不抑制旧存量泛红（清库 / 重装即可）。
 */
export function computeUnread(
  entry: PrIndexEntry,
  readState: PrReadStateFile | null,
  pr: StoredPullRequest,
): boolean {
  if (!readState) return true;
  const commitUnread = pr.sourceRef.sha !== readState.lastReadHeadSha;
  const mentionUnread =
    entry.lastMentionAt != null && Date.parse(entry.lastMentionAt) > Date.parse(readState.lastReadAt);
  return commitUnread || mentionUnread;
}

/**
 * 列出当前**活跃** (非软删) 的 PR。
 *
 * 实现：先读索引 → 过滤掉 archivedAt 非空的 → 逐个读 meta.json + read-state.json。索引里没有但目录
 * 还在的 meta 视为孤儿，跳过 (poll 阶段会清掉)。
 *
 * 返回时据已读水位派生 `unread` 标记叠加到每条 PR 上（meta.json 本身不存此字段）。
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
    if (!meta) continue;
    const readState = await readPrReadState(store, localId);
    out.push({ ...meta.pr, unread: computeUnread(entry, readState, meta.pr) });
  }
  return out;
}

/**
 * 列出**已归档**（退场 / 软删）的 PR，供「已关闭」视图浏览。
 *
 * 索引仍只在 `stateStore` 维护（archivedAt 非空即归档）；PR 实体目录在退场时整树搬入 `archiveStore`
 * 冷存储，故逐个 meta 从 archiveStore 读。索引有条目但 archiveStore 无 meta（搬迁中途 / 旧布局）即跳过。
 * 归档 PR 一律视为已读（不参与未读派生）。
 */
export async function listArchivedPullRequests(
  stateStore: StateStore,
  archiveStore: StateStore,
): Promise<StoredPullRequest[]> {
  const index = await readPrIndex(stateStore);
  if (!index) return [];
  const out: StoredPullRequest[] = [];
  for (const [localId, entry] of Object.entries(index.prs)) {
    if (!entry.archivedAt) continue;
    const meta = await readPrMeta(archiveStore, localId);
    if (!meta) continue;
    out.push({ ...meta.pr, unread: false });
  }
  return out;
}

/**
 * 标记 PR 为已读：把已读水位推进到当前 head sha + now。用户打开 PR 时由 IPC 调用。仅写 read-state.json
 * （不碰 index.json），故与周期性 poll 的索引重写互不干扰。找不到 meta 返回 null；否则返回带 `unread:false` 的最新 PR。
 */
export async function markPrRead(
  store: StateStore,
  localId: string,
  now: string = new Date().toISOString(),
): Promise<StoredPullRequest | null> {
  const meta = await readPrMeta(store, localId);
  if (!meta) return null;
  await writePrReadState(store, localId, {
    lastReadHeadSha: meta.pr.sourceRef.sha,
    lastReadAt: now,
  });
  return { ...meta.pr, unread: false };
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
