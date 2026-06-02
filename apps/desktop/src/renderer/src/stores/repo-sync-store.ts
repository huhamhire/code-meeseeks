import { useSyncExternalStore } from 'react';
import type { SyncProgressEvent } from '@pr-pilot/shared';
import { subscribe } from '../api';

/**
 * 跨组件共享的当前活动 repo sync 状态。
 *
 * 数据来源：main 的 `sync:progress` 事件流（每个 repo 的 start/progress/done/error）。
 * 一个 repo 一条记录：start → 进 active，progress 更新阶段+百分比，done/error 移出。
 *
 * UI 用法：StatusBar 取 `getActive()` 第一条展示；没有任何 active 时 chip 隐藏不占位。
 * 同一时刻可能有多个 repo 排队 (RepoMirrorManager 已是全局单队列串行)，store 都收着
 * 便于"还有 N 个在排队"扩展，第一版只展示首条。
 */
export interface RepoSyncState {
  /** repoKey ("host/group/repo") → 当前阶段快照 */
  active: ReadonlyMap<string, RepoSyncSnapshot>;
}

export interface RepoSyncSnapshot {
  /** 来自 sync:progress.repo，"host/projectKey/repoSlug" */
  repo: string;
  /** simple-git 阶段名（compressing / receiving / resolving / ...）；start 时可能空 */
  stage?: string;
  /** 0-100；progress 阶段填，done 时一般已到 100 */
  percent?: number;
  /** 给 hover tooltip / 排障用 */
  message?: string;
  /** 进入 active 的时间戳，用于 UI 排序 / "停留 X 秒" 显示 */
  startedAt: number;
}

let state: RepoSyncState = { active: new Map() };
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

function setActive(next: ReadonlyMap<string, RepoSyncSnapshot>): void {
  state = { active: next };
  notify();
}

function handleEvent(ev: SyncProgressEvent, nowMs: number): void {
  const next = new Map(state.active);
  if (ev.phase === 'done' || ev.phase === 'error') {
    next.delete(ev.repo);
  } else {
    const prev = next.get(ev.repo);
    next.set(ev.repo, {
      repo: ev.repo,
      stage: ev.stage ?? prev?.stage,
      percent: ev.percent ?? prev?.percent,
      message: ev.message ?? prev?.message,
      startedAt: prev?.startedAt ?? nowMs,
    });
  }
  setActive(next);
}

export const repoSyncStore = {
  getSnapshot: (): RepoSyncState => state,
  subscribe: (cb: () => void): (() => void) => {
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  },
  /** 测试 / 调试用：直接灌一条事件 */
  handleEvent,
};

export function useRepoSyncStore(): RepoSyncState {
  return useSyncExternalStore(repoSyncStore.subscribe, repoSyncStore.getSnapshot);
}

/**
 * 把 IPC sync:progress 事件接到 store。App 顶层 useEffect 调一次。
 * Date.now() 仅在事件发生时本地取，store 自身保持纯。
 */
export function wireRepoSyncStore(): () => void {
  return subscribe('sync:progress', (ev) => {
    handleEvent(ev, Date.now());
  });
}
