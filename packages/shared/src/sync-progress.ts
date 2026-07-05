/**
 * Repo sync progress event. Emitted by RepoMirrorManager via the onProgress callback during clone/fetch;
 * the main process pushes it to the renderer over IPC (the `sync:progress` event). Referenced both by
 * @meebox/repo-mirror (producer) and @meebox/ipc (IpcEvents payload), so it lives in shared as a shared domain type.
 */
export interface SyncProgressEvent {
  /** "host/projectKey/repoSlug" identifier */
  repo: string;
  phase: 'start' | 'progress' | 'done' | 'error';
  /** simple-git stage name (compressing / receiving / resolving / ...) */
  stage?: string;
  /** 0-100 */
  percent?: number;
  /** Human-readable message */
  message?: string;
}
