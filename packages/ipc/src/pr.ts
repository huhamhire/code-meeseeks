import type {
  AskVerdict,
  FindingClosure,
  LocalPrStatus,
  PlatformUser,
  PollResult,
  PrActivityEvent,
  PrComment,
  PrCommit,
  PrDiscoveryFilter,
  ReviewDraft,
  StoredPullRequest,
} from '@meebox/shared';
import type { DiffBlameLine, DiffChangedFile, DiffFileContent, DiffSide } from './common.js';

/** PR operations domain: comments / list / status / merge / mirror / diff / drafts. */
export interface PrChannels {
  /**
   * Fetch an image embedded in a comment body (`![alt](url)`). The url may be a Bitbucket attachment absolute/relative address;
   * a private instance requires a PAT to fetch → the renderer `<img>` tag cannot fetch it directly, so it must go through the main proxy.
   * Returns a data URL for the renderer to put in `<img src>`; returns null on fetch failure (404 / cross-host / non-image)
   */
  'comments:fetchAttachment': {
    request: { localId: string; url: string };
    response: { dataUrl: string } | null;
  };
  /**
   * Reply to an existing comment. After a successful submit, the main side refreshes the comments cache + broadcasts
   * the comments:changed event; renderer components refetch the list and automatically show the new reply
   */
  'comments:reply': {
    request: { localId: string; parentCommentId: string; body: string };
    response: PrComment;
  };
  /**
   * Post a summary (top-level, not anchored to a file) comment on the PR. On success the main side clears the comment cache + broadcasts
   * comments:changed; the activity / comments panel refetches automatically, and the new comment appears at the top of the timeline.
   */
  'comments:create': {
    request: { localId: string; body: string };
    response: PrComment;
  };
  /**
   * Delete a remote comment you authored. Bitbucket requires a version (optimistic lock), which the caller takes from an existing PrComment;
   * mismatch / comment already has replies / not being the author all fail (Bitbucket 409/403). On success the main
   * side clears the comment cache + broadcasts comments:changed, and the UI refetches to refresh automatically
   */
  'comments:delete': {
    request: { localId: string; commentId: string; version: number };
    response: void;
  };
  /**
   * Edit the body of a comment you authored. Bitbucket PUT also requires a version (optimistic lock) — a mismatch returns 409,
   * and the upper layer should prompt "remote has updated, please refresh and retry" and refuse to overwrite silently. Bitbucket allows editing a comment
   * that has replies (unlike delete). On success the main side clears the comment cache + broadcasts
   * comments:changed, and the UI refetches automatically to show the new text
   */
  'comments:edit': {
    request: {
      localId: string;
      commentId: string;
      version: number;
      body: string;
    };
    response: PrComment;
  };
  /**
   * Toggle the current user's emoji reaction on a comment (add=true to add / false to remove). emoji is a normalized Unicode character
   * (see shared REACTION_PICKER); kind distinguishes summary / inline (GitHub picks the reaction endpoint accordingly). On success the main
   * side clears the comment cache + broadcasts comments:changed, and the UI refetches to refresh the reaction bar. Exposed only on platforms where the commentReactions capability is true.
   */
  'comments:toggleReaction': {
    request: {
      localId: string;
      commentId: string;
      kind: 'summary' | 'inline';
      emoji: string;
      add: boolean;
    };
    response: void;
  };
  /**
   * Upload an image as a comment attachment (triggered by paste / picker), returns a markdown snippet insertable into the body; unsupported platforms
   * (GitHub) return null. bytes are transferred over IPC as an ArrayBuffer, which the main side converts to Uint8Array and hands to the adapter to upload.
   * The entry point is exposed only on platforms where the commentAttachments capability is true.
   */
  'comments:uploadAttachment': {
    request: { localId: string; fileName: string; contentType: string; bytes: ArrayBuffer };
    response: { markdown: string } | null;
  };
  /**
   * Search platform users for `@mention` autocomplete (exposed only where the `userSearch` capability is true).
   * The mention editor calls this as a debounced fallback once the bounded local candidate set (this PR's participants)
   * is exhausted, so the user can mention people outside the PR without knowing the exact username. The connection is
   * resolved from `localId` (the PR's platform / repo). Returns a bounded, platform-relevance-ordered list; an empty /
   * too-short query or a search failure resolves to `[]` (the editor silently falls back to the local menu).
   */
  'mentions:search': {
    request: { localId: string; query: string };
    response: PlatformUser[];
  };
  'prs:list': { request: void; response: StoredPullRequest[] };
  /** List archived (retired) PRs: read from cold storage, for the "closed" view to browse (read-only). */
  'prs:listArchived': { request: void; response: StoredPullRequest[] };
  /**
   * Open the current platform's PR by URL: parse the link → if it already exists locally (active / archived) locate it directly; otherwise fetch from remote (authenticated),
   * store into archive cold storage, then locate it. Returns its localId and location; throws an AppError error code on parse failure / no permission / not found.
   */
  'prs:openByUrl': {
    request: { url: string };
    /** discoveryFilters: the discovery categories an active PR belongs to (the frontend uses this to land on a tab that can show it); empty for archived PRs. */
    response: {
      localId: string;
      location: 'active' | 'archived';
      discoveryFilters: PrDiscoveryFilter[];
    };
  };
  'prs:refresh': { request: void; response: PollResult };
  /** Poller's last completion time (ISO or null); used for initialization at startup */
  'prs:lastSync': { request: void; response: { at: string | null } };
  'prs:setLocalStatus': {
    request: { localId: string; status: LocalPrStatus };
    response: StoredPullRequest | null;
  };
  /**
   * Mark a PR as read: advance the read watermark (current head sha + time) and clear the unread flag. Called when the user opens the PR.
   * Returns the latest PR with `unread:false` (returns null if not found). The next poll round will not mark it unread again due to old events.
   */
  'prs:markRead': {
    request: { localId: string };
    response: StoredPullRequest | null;
  };
  /**
   * Merge the PR into the target branch (entry point exposed only for PRs with canMerge=true). On success the remote PR turns
   * MERGED, and the caller should refresh the list itself (the next poll round will soft-delete the PR). On failure it throws, bubbling up to the renderer.
   */
  'prs:merge': {
    request: { localId: string };
    response: void;
  };
  /** Sync the local mirror of the PR's repo (clone if necessary, otherwise fetch), returns the mirror's absolute path */
  'repo:sync': {
    request: { localId: string };
    response: { mirrorPath: string; freshClone: boolean };
  };
  /**
   * List changed files (automatically syncs the mirror first). Defaults to all changes from PR baseSha → headSha;
   * passing base / head (e.g. a commit's `parent..sha`) lists the changes in that range, used for "view a specific commit".
   */
  'diff:listChangedFiles': {
    request: { localId: string; base?: string; head?: string };
    response: DiffChangedFile[];
  };
  /**
   * List file paths that would conflict when merging into the target branch (a `git merge-tree` trial merge of PR target tip ⟂ source head).
   * Actually runs merge-tree only when `pr.hasConflict` is true, otherwise returns an empty array directly (saving one local trial merge).
   * Returns an empty array on trial-merge failure / when undecidable (conservatively not flagging conflict); the file tree uses this to mark a triangle warning icon on the corresponding row.
   */
  'diff:listConflictFiles': {
    request: { localId: string };
    response: string[];
  };
  /**
   * Read the content of a file on the base or head side (binary returns {binary:true}). Defaults to the PR base / head side;
   * passing base / head sha reads by the specified range (commit view: base=parent, head=commit).
   */
  'diff:getFileContent': {
    request: { localId: string; side: DiffSide; path: string; base?: string; head?: string };
    response: DiffFileContent;
  };
  /**
   * Fetch existing comments on the PR (both inline + summary are fetched, renderer splits them itself).
   *
   * Defaults to cache + pr_updated_at stale comparison: on a hit return the cache, on stale/miss fetch remote.
   * But local PR.updatedAt comes from the poller's periodic fetch and may lag — after a remote comment is added,
   * local updatedAt stays unchanged → cache falsely hits → no refresh. When opening a PR the renderer should
   * pass force=true to skip the stale comparison and force one remote fetch, ensuring the badge count / inline
   * comments are up to date
   */
  'diff:listComments': {
    request: { localId: string; force?: boolean };
    response: PrComment[];
  };
  /**
   * Read only the total count from the comment cache (inline + summary top-level entry count; does not expand replies), **without**
   * hitting remote. The UI uses it for lazy display of the tab badge "Comments (N)": if the cache has it, show directly; if the cache is empty, do not show.
   * When the user switches to the Comments tab it triggers `diff:listComments` to fetch remote + write the cache, so the next time the PR is opened
   * the badge has a number.
   */
  'diff:commentCountCached': {
    request: { localId: string };
    response: { count: number } | null;
  };
  /** Fetch the commits contained in the PR, newest first */
  'diff:listCommits': {
    request: { localId: string };
    response: PrCommit[];
  };
  /**
   * Fetch review-verdict activity events on the PR (approve / needs-work / unapprove / dismiss), with timestamps.
   * The activity timeline merges them with comments / commits by time. Not cached (small volume, on par with commits); when the platform cannot retrieve historical
   * verdicts (e.g. GitLab CE has no approvals) it returns [], and the timeline shows only comments and commits.
   */
  'diff:listActivity': {
    request: { localId: string };
    response: PrActivityEvent[];
  };
  /**
   * Local git rev-list to count the commits the PR introduces (base..head). Entirely via the local bare mirror,
   * no remote hit; if any sha is not in the mirror (not yet synced to this PR range) → null.
   * The UI uses it for lazy display of the Commits tab badge, same pattern as diff:commentCountCached
   */
  'diff:commitCount': {
    request: { localId: string };
    response: { count: number } | null;
  };
  /**
   * Run git blame on the head-side file; also returns the set of head line numbers the PR introduces,
   * so the renderer can distinguish "unchanged lines (show blame)" vs "PR-changed lines (show a color-band placeholder)".
   */
  'diff:getBlame': {
    request: { localId: string; path: string; base?: string; head?: string };
    response: {
      /** Blame for unchanged lines only (PR-changed lines already filtered out) */
      lines: DiffBlameLine[];
      /** Head line numbers the PR introduces (added / modified), used to draw the color-band placeholder in the blame column */
      changedLines: number[];
    };
  };
  /** Compute the total bytes used by all local repo mirrors (for the settings page) */
  'repo:getTotalSize': { request: void; response: { totalBytes: number } };
  /**
   * List all drafts of the given PR (pending / edited / posted / rejected are all returned; the UI filters by
   * status to display / collapse).
   */
  'drafts:list': {
    request: { localId: string };
    response: ReviewDraft[];
  };
  /**
   * Create a draft. id / createdAt / updatedAt are generated by the main side; the caller only passes business fields.
   * Call convention: when origin='finding' source must be passed; when origin='manual' do not pass source.
   * On success the main side broadcasts the `drafts:changed` event.
   */
  'drafts:create': {
    request: {
      localId: string;
      draft: Omit<ReviewDraft, 'id' | 'createdAt' | 'updatedAt' | 'prLocalId'>;
    };
    response: ReviewDraft;
  };
  /**
   * Partially update a draft. Rules:
   * - editing body while status='pending' → automatically turns 'edited'
   * - explicitly passing status (e.g., 'rejected') → overwrite with the passed value
   * - draftId not found returns null (no throw, UI falls back silently)
   */
  'drafts:update': {
    request: {
      localId: string;
      draftId: string;
      patch: Partial<Pick<ReviewDraft, 'body' | 'status' | 'posted_remote_id'>>;
    };
    response: ReviewDraft | null;
  };
  /** Delete a draft. Deleting a posted draft is allowed (only clears local, remote comment is untouched) */
  'drafts:delete': {
    request: { localId: string; draftId: string };
    response: void;
  };
  /**
   * finding closure relation (established when a re-review /ask "supersedes / revokes" the original finding). Independent of drafts, it only affects the closed state
   * of the ChatPane finding card + its cross-link with the re-review card. After create/delete the main side broadcasts `findingClosures:changed`.
   */
  'findingClosures:list': {
    request: { localId: string };
    response: FindingClosure[];
  };
  'findingClosures:create': {
    request: {
      localId: string;
      runId: string;
      findingId: string;
      byAskRunId: string;
      verdict: AskVerdict;
    };
    response: FindingClosure;
  };
  'findingClosures:delete': {
    request: { localId: string; runId: string; findingId: string };
    response: void;
  };
  /**
   * Batch-publish drafts to remote: each draft is sent to Bitbucket via adapter.publishInlineComment,
   * success → local draft status='posted' + write posted_remote_id; failure → keep the original status
   * unchanged and collect the error into results. **A single failure does not interrupt subsequent items** —— aligned with the Bitbucket web UI
   * "Start review" behavior (which also POSTs one by one, where one 400 does not affect others).
   *
   * After publishing all at once, main will:
   * 1. broadcast `drafts:changed` —— DiffView / FindingCard refetch drafts and swap the status chip
   * 2. force-refresh Bitbucket PR comments (skip cache) + broadcast `comments:changed`, so CommentsPanel
   *    immediately sees the comments it just published, without waiting for the next poller round
   *
   * The caller (renderer modal) uses results to show "N succeeded M failed" + error details
   */
  'drafts:publishBatch': {
    request: { localId: string; draftIds: string[] };
    response: {
      results: Array<{
        draftId: string;
        ok: boolean;
        /** Filled on success, same value as the persisted draft.posted_remote_id */
        postedRemoteId?: string;
        /** Filled on failure, human-readable error reason (Bitbucket REST 4xx body wrapped via PlatformError) */
        error?: string;
      }>;
    };
  };
}
