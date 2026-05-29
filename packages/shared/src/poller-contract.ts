import type { PullRequest } from './platform.js';

export type LocalPrStatus = 'pending' | 'reviewed' | 'skipped';

/**
 * 状态库里存的 PR：在远端字段之上叠加本地维度（归属连接、本地状态、发现/最后看到时间）。
 * 既在主进程持久化用，也是 renderer 经由 IPC 拿到的形状。
 */
export interface StoredPullRequest extends PullRequest {
  /** "<connectionId>:<remoteId>"，跨连接唯一 */
  localId: string;
  connectionId: string;
  localStatus: LocalPrStatus;
  /** 首次被 poll 发现的时间，ISO */
  discoveredAt: string;
  /** 最近一次 poll 仍能看到的时间，ISO */
  lastSeenAt: string;
}

export interface PollResult {
  /** 本轮所有连接合并返回的 PR 总数 */
  fetched: number;
  /** 比上次 updatedAt 有变化的 PR 数 */
  changed: number;
  /** 本轮新增的 PR 数 */
  added: number;
  /** poll 失败的连接数 */
  errors: number;
}
