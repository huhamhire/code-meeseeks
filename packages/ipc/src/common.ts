import type {
  PlatformCapabilities,
  PlatformUser,
  ReviewRunCommitScope,
  ReviewRunOrigin,
  ReviewRunTool,
} from '@meebox/shared';

/** ChangedFile / FileContent for use across the IPC boundary, same shape as the @meebox/repo-mirror types. */
export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';

export interface DiffChangedFile {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  similarity?: number;
}

/**
 * File content for diff rendering. `binary: true` = not rendered as a text diff; the optional `lfs` field marks a Git
 * LFS-managed file (the mirror holds the LFS pointer, so we show an LFS placeholder + the real byte size instead of the
 * pointer text). `binary: true` with no `lfs` is a plain inline binary (committed to git directly, not LFS).
 */
export type DiffFileContent =
  | { binary: false; content: string }
  | { binary: true; lfs?: { size: number | null } };

export type DiffSide = 'base' | 'head';

/** Single-line blame info (main runs git blame --porcelain, the renderer renders the left column). */
export interface DiffBlameLine {
  line: number;
  commit: string;
  author: string;
  authorEmail: string;
  authorDate: string;
  summary: string;
}

export interface ConnectionSummary {
  connectionId: string;
  /** display_name from config */
  displayName: string;
  /** the user owning the current PAT, cached after ping; null when ping is incomplete or failed */
  user: PlatformUser | null;
  /** the capability descriptor of the platform this connection belongs to; the renderer shows/hides/grays out accordingly (multi-platform degradation, see platform.ts) */
  capabilities: PlatformCapabilities;
}

/**
 * Metadata for one pr-agent run, covering both "running (active)" and "queued (waiting)" states.
 *
 * - active: `startedAt` is the ISO start time, the UI timer's origin
 * - waiting: `startedAt` is null, the UI shows "queued" + enqueuedAt
 *
 * runId is generated at enqueue (matching the eventually-persisted ReviewRun.id; the queued state is not written to disk, only when actually
 * starting does startReviewRun land it on disk). This lets `pragent:cancel(runId)` reference the same id in both queued/active
 * states.
 */
export interface PragentRunInfo {
  runId: string;
  prLocalId: string;
  /** Repo slug and PR number (for queue display, avoiding showing only the localId hash). */
  repoSlug: string;
  prNumber: string;
  tool: ReviewRunTool;
  question?: string;
  /** Trigger origin: user (manually initiated) / agent (dispatched by orchestration). ChatPane uses this to add a command echo bubble for running runs of user origin. */
  origin: ReviewRunOrigin;
  /** Single-commit review range (parent..sha); filled when limited to a commit, and the running card shows a range badge from it. Default = whole PR. */
  scope?: ReviewRunCommitScope;
  /** Enqueue time, ISO */
  enqueuedAt: string;
  /** Execution start time, ISO; null in the waiting state */
  startedAt: string | null;
}

/** Compatibility for legacy references: the active state is essentially a PragentRunInfo with non-null startedAt */
export type ActiveRunInfo = PragentRunInfo;
