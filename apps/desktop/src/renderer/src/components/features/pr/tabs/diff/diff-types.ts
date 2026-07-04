import type { DiffChangedFile, DiffFileContent } from '@meebox/ipc';

/**
 * diff change scope: 'all' = all PR changes (merge-base..head); 'commit' = a single commit's parent..sha.
 * commit view is a read-only diff (inline comments / drafts are anchored to the full-PR diff line numbers, not applied to the single-commit version).
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

/** "View specific commit" request payload (parent comes from PrCommit.parents[0]; a root commit has no parent, so null). */
export interface PendingCommitView {
  sha: string;
  parent: string | null;
  abbreviatedSha: string;
  subject: string;
}

export function fileKey(f: DiffChangedFile): string {
  return `${f.oldPath ?? ''}|${f.path}`;
}
