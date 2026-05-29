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

export type ChangedFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange';

export interface ChangedFile {
  /** 新路径（A/M/T）；R/C 时为目标 path */
  path: string;
  /** 仅 R/C 时存在，源 path */
  oldPath?: string;
  status: ChangedFileStatus;
  /** R/C 时的相似度百分比 (0-100) */
  similarity?: number;
}

export type FileContent = { binary: false; content: string } | { binary: true };

/** 单行 blame 信息。从 `git blame --porcelain <sha> -- <path>` 解析。 */
export interface BlameLine {
  /** 该行在 head 侧的行号（1-based） */
  line: number;
  /** 该行所属 commit 的完整 sha */
  commit: string;
  author: string;
  authorEmail: string;
  /** 作者时间 ISO */
  authorDate: string;
  summary: string;
}
