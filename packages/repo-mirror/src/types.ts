export interface RepoIdentity {
  /** 来自 connection.base_url 的 host（不含 scheme），用于按主机分目录 */
  host: string;
  projectKey: string;
  repoSlug: string;
}

export interface MirrorResult {
  /** bare 镜像的绝对路径，<reposDir>/<host>/<projectKey>/<repoSlug>/bare */
  mirrorPath: string;
  /** 本次是否做了首次 clone（vs 后续 fetch） */
  freshClone: boolean;
}

export interface RepoSize {
  /** 字节，包含 bare repo 全部内容 */
  totalBytes: number;
}
