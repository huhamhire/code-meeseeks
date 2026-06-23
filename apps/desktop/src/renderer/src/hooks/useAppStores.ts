import { useEffect } from 'react';
import { wireChatRunStore } from '../stores/chat-run-store';
import { wireDraftsStore } from '../stores/drafts-store';
import { wireFindingClosuresStore } from '../stores/finding-closures-store';
import { wireRepoSyncStore } from '../stores/repo-sync-store';

/**
 * 把 IPC 事件流接到各全局 store（挂载到 React 树根，效果等价于「应用级 hook」）：
 * - chatRunStore：pr-agent 活动 run + 实时 stdout，ChatPane 跨 PR 切换可读回运行态
 * - repoSyncStore：repo 镜像 clone/fetch 进度，StatusBar 任意时刻可读当前同步任务
 * - draftsStore：草稿写盘后 drafts:changed 触发指定 PR 的草稿列表自动刷新
 */
export function useAppStores(): void {
  useEffect(() => wireChatRunStore(), []);
  useEffect(() => wireRepoSyncStore(), []);
  useEffect(() => wireDraftsStore(), []);
  useEffect(() => wireFindingClosuresStore(), []);
}
