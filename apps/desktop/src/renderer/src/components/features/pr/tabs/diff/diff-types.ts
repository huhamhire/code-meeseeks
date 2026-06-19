import type { DiffChangedFile, DiffFileContent } from '@meebox/ipc';

/**
 * diff 变更范围：'all' = PR 全部变更（merge-base..head）；'commit' = 单个 commit 的 parent..sha。
 * commit 视图为只读 diff（行内评论 / 草稿锚定在 PR 全量 diff 行号上，不套用于单 commit 版本）。
 */
export type DiffScope =
  | { kind: 'all' }
  | {
      kind: 'commit';
      sha: string;
      parent: string | null;
      abbreviatedSha: string;
      subject: string;
    };

export interface LoadedContent {
  base: DiffFileContent;
  head: DiffFileContent;
}

/** 「查看特定 commit」请求载荷（parent 来自 PrCommit.parents[0]，root commit 无 parent 为 null）。 */
export interface PendingCommitView {
  sha: string;
  parent: string | null;
  abbreviatedSha: string;
  subject: string;
}

export function fileKey(f: DiffChangedFile): string {
  return `${f.oldPath ?? ''}|${f.path}`;
}
