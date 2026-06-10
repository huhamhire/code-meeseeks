import type { PlatformUser } from '@meebox/shared';
import type { StateStore } from '@meebox/state-store';

/**
 * 连接级本地状态（按 connectionId 持久化在 state store）。当前只存「上次 ping 拿到的当前
 * 用户身份」用于预热 poller 判 approved（首轮即正确、不必等 ping）；结构刻意留作可扩展，
 * 后续可在此追加其它连接级交互状态（如最近查看时间、列表偏好等）。
 */
export interface ConnectionState {
  /** 上次 ping 得到的当前 PAT 所属用户；用于建连接时预热 adapter 的 currentUser 缓存。 */
  user?: PlatformUser | null;
}

interface ConnectionStateFile {
  schema_version: 1;
  /** connectionId → 该连接的本地状态 */
  connections: Record<string, ConnectionState>;
}

const KEY = 'connections/state';

/** 读取全部连接状态；无文件返回空表。 */
export async function readConnectionStates(
  store: StateStore,
): Promise<Record<string, ConnectionState>> {
  const file = await store.read<ConnectionStateFile>(KEY);
  return file?.connections ?? {};
}

/** 整表写回连接状态。 */
export async function writeConnectionStates(
  store: StateStore,
  connections: Record<string, ConnectionState>,
): Promise<void> {
  await store.write<ConnectionStateFile>(KEY, { schema_version: 1, connections });
}
