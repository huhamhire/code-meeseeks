export interface RepoIdentity {
  /** host from connection.base_url (no scheme), used to split directories by host */
  host: string;
  projectKey: string;
  repoSlug: string;
}

export interface MirrorResult {
  /** absolute path of the bare mirror, <reposDir>/<host>/<projectKey>/<repoSlug>/bare */
  mirrorPath: string;
  /** whether this call did a first-time clone (vs a subsequent fetch) */
  freshClone: boolean;
}

export interface RepoSize {
  /** bytes, covering the entire contents of the bare repo */
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
  /** new path (A/M/T); the target path for R/C */
  path: string;
  /** present only for R/C, the source path */
  oldPath?: string;
  status: ChangedFileStatus;
  /** similarity percentage for R/C (0-100) */
  similarity?: number;
}

export type FileContent = { binary: false; content: string } | { binary: true };

/** Single-line blame info. Parsed from `git blame --porcelain <sha> -- <path>`. */
export interface BlameLine {
  /** line number on the head side (1-based) */
  line: number;
  /** full sha of the commit this line belongs to */
  commit: string;
  author: string;
  authorEmail: string;
  /** author time, ISO */
  authorDate: string;
  summary: string;
}
