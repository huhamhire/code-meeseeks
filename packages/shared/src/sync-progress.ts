/**
 * 仓库 sync 进度事件。RepoMirrorManager 在 clone/fetch 期间通过 onProgress 回调发出；
 * main 进程经 IPC（`sync:progress` 事件）转推到 renderer。既被 @meebox/repo-mirror（产出方）
 * 也被 @meebox/ipc（IpcEvents 载荷）引用，故置于 shared 作为共享领域类型。
 */
export interface SyncProgressEvent {
  /** "host/projectKey/repoSlug" 标识 */
  repo: string;
  phase: 'start' | 'progress' | 'done' | 'error';
  /** simple-git 阶段名（compressing / receiving / resolving / ...） */
  stage?: string;
  /** 0-100 */
  percent?: number;
  /** 人读消息 */
  message?: string;
}
