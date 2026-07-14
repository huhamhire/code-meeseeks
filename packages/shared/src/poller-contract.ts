import type {
  PlatformKind,
  PlatformUser,
  PrCommentAnchor,
  PrDiscoveryFilter,
  PullRequest,
  RepoRef,
} from './platform.js';
import type { PrAgentStrategy } from './pr-agent-status.js';
import type { ReviewRunTool } from './tool-registry.js';

/**
 * Local review verdict. One-to-one with Bitbucket reviewer.status; the UI drives two toggle buttons from it:
 * - pending: default (UNAPPROVED), no review verdict given yet
 * - approved: approved
 * - needs_work: marked NEEDS_WORK
 *
 * Clicking in the UI syncs to remote Bitbucket (participant status), and the next poll round fetches it back to stay consistent.
 */
export type LocalPrStatus = 'pending' | 'approved' | 'needs_work';

// The tool enum ReviewRunTool is in the unified registry tool-registry (add new tools there). Note: improve's pr-agent local
// provider doesn't implement `publish_code_suggestions`, so its output goes through review.md (shared with review / ask); parseReviewOutput
// takes a dedicated parse path for tool='improve', splitting each <details> suggestion into an anchored code-feedback finding.

export type ReviewRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * The failure classification for a single pr-agent invocation.
 *
 * 'llm-error' differs from other reasons — the pr-agent CLI itself may exit 0 (it internally catches
 * LLM errors and only logger.warning's about them), but stdout shows a marker like "Failed to generate
 * prediction with any model" / "Error during LLM inference".
 * When parseReviewOutput detects such a marker it upgrades status to 'failed' +
 * reason='llm-error', so the UI doesn't present a run where all LLM calls failed as "successfully completed"
 */
export type ReviewRunFailureReason =
  | 'timeout'
  | 'spawn-failed'
  | 'non-zero-exit'
  | 'killed'
  | 'cancelled'
  | 'llm-error';

/**
 * A single finding obtained after parsing pr-agent stdout. category reflects the source:
 * - description: the description section from /describe output
 * - code-feedback: a code suggestion anchored to a specific file / line (has anchor)
 * - general: other markdown sections (such as estimated effort / score / relevant tests)
 */
export type FindingCategory = 'description' | 'general' | 'code-feedback';

/**
 * Standardized pr-agent output section key. Normalizes section titles across pr-agent versions (which may carry
 * **bold** / differ in case / have Chinese-English variants) to a stable identifier; the UI decides sorting / coloring /
 * whether to hide / later specialized cards by key.
 */
export type PrDocSectionKey =
  | 'title' // Suggested PR title
  | 'pr-type' // Type label (Bug fix / Enhancement / Tests / ...)
  | 'summary' // /review top summary
  | 'description' // Main description section
  | 'diagram' // Architecture diagram (changes_diagram, mermaid)
  | 'assessment' // Approach suggestions (injected field: alternatives + preference recommendation, aligned with Qodo High-Level Assessment)
  | 'walkthrough' // File-level walkthrough
  | 'relevant-tests' // Relevant tests
  | 'security' // Security findings
  | 'code-feedback' // /review single finding (with file:line anchor)
  | 'code-suggestion' // /improve single improvement suggestion (with file:line anchor + existing/improved diff)
  | 'ask-summary' // /ask structured section: conclusion / direct answer (highlighted, expanded)
  | 'ask-analysis' // /ask structured section: procedural analysis / discussion (collapsed by default)
  | 'ask-suggestions' // /ask structured section: actionable suggestions (highlighted)
  | 'effort' // Estimated effort 1-5
  | 'score' // Quality score
  | 'general'; // Fallback, unrecognized

export interface FindingAnchor {
  path: string;
  startLine?: number;
  endLine?: number;
}

/** Finding severity: used by the M4 review publish loop; the UI decides chip coloring / sort priority */
export type FindingSeverity = 'info' | 'warning' | 'error';

/**
 * The Finding's state machine in the review → publish loop:
 *   pending  : default, awaiting the user's decision
 *   accepted : user checked to accept (will be published as an inline / summary comment)
 *   edited   : user rewrote the content (draft_body holds the edited version)
 *   rejected : user rejected; not published
 *   posted   : published to the remote (posted_remote_id holds the remote comment id, used for idempotency)
 */
export type FindingStatus = 'pending' | 'accepted' | 'edited' | 'rejected' | 'posted';

/**
 * The "before/after code" comparison of a single /improve suggestion. pr-agent gives both existing + improved
 * content in a `diff` code block in the markdown; after parsing we split into two strings, and the UI renders
 * with single-language syntax highlight (anchor.path gives the file type). Both sides are fragments, not necessarily independently runnable/compilable.
 */
export interface FindingCodeChange {
  existing: string;
  improved: string;
}

export interface Finding {
  /** Id stable within the same run, convenient for UI list-key + later "turn into comment draft" references */
  id: string;
  category: FindingCategory;
  /**
   * Section normalization key. Every newly parsed finding carries it; old persisted runs lack this field (fall back to category).
   * The UI decides sorting + visual layering by sectionKey
   */
  sectionKey?: PrDocSectionKey;
  /** From the markdown header (with **__ emphasis symbols stripped); may be empty */
  title?: string;
  /** Raw markdown body (with formatting), rendered by the UI with react-markdown */
  body: string;
  /** Present when category='code-feedback' / 'code-suggestion' */
  anchor?: FindingAnchor;
  /**
   * The "original code → improved code" comparison carried by an /improve suggestion. Filled only when sectionKey='code-suggestion'.
   * The UI renders the before/after fragments with single-language syntax highlight
   */
  codeChange?: FindingCodeChange;
  /**
   * The importance score 1-10 given by /improve. Filled only when sectionKey='code-suggestion'.
   * Combined with severity (M4 review decision) for sorting / coloring: score ≥ 8 defaults to 'warning', < 5 defaults to 'info'
   */
  score?: number;
  /**
   * Severity (M4); the current parser doesn't fill it; M4 will add the inference logic per pr-agent output / rules when wiring up /improve.
   * The UI renders as 'info' by default
   */
  severity?: FindingSeverity;
  /**
   * Publish loop status (M4); defaults to 'pending'. All findings default to pending; after the user checks them in
   * the Findings Drawer they become accepted / edited / rejected; a successful publish turns them to posted
   */
  status?: FindingStatus;
  /**
   * The comment body after user editing. Filled only when status='edited'; for other states the UI reads body directly
   */
  draft_body?: string;
  /**
   * The remote comment id after a successful publish (e.g., Bitbucket comment id). Used as an idempotency key to prevent the same finding
   * from being published twice; redundant with state/posted-comments.json, but the former is by finding dimension and
   * the latter is a global index by (finding_id, remote_id) dimension — complementary uses
   */
  posted_remote_id?: string;
}

/**
 * The "draft" of the M4 review → publish loop.
 *
 * A draft's lifecycle is decoupled from Finding:
 * - Finding is the immutable snapshot of /review (what ran, what the AI said)
 * - Draft is the mutable state in the user's work (the object the user edits / rejects / publishes)
 *
 * Persisted to `state/prs/<localId>/drafts.json`, a per-PR directory; when the PR leaves,
 * deleteDir clears the whole tree.
 *
 * State machine:
 *   pending  ──(user edits body)──► edited
 *   pending  ──(user rejects)──────► rejected
 *   edited   ──(user rejects)──────► rejected
 *   pending / edited  ──(batch publish succeeds)──► posted
 *   posted   ──► (terminal, unchanged locally; to change the remote use the Bitbucket API)
 */
export interface ReviewDraft {
  /** Unique stable id (uuid or derived from runId+findingId), for UI list-key + persistence references */
  id: string;
  /** PR hash localId, consistent with the parent directory */
  prLocalId: string;
  /**
   * Draft kind: a brand-new inline/file comment (`comment`) vs a reply to an existing comment (`reply`). Absent =
   * `comment` (back-compat: drafts persisted before reply-drafts existed, and all `finding`-origin drafts, are comments).
   * A reply defers the same way a new comment does — it sits in the draft pool and publishes via the batch — but
   * publishes through the reply API against {@link replyTo} instead of a fresh inline comment.
   */
  kind?: 'comment' | 'reply';
  /**
   * Anchor to a specific line. **Required for a `comment`** (a new comment must land on a line). For a `reply` it is a
   * snapshot of the parent comment's anchor: present when replying to an inline comment (positions the draft zone at
   * the parent's line), absent when replying to a summary comment (which has no line — that reply-draft shows only in
   * the drafts panel / activity timeline, never as a diff zone).
   */
  anchor?: ReviewDraftAnchor;
  /** Reply target (which existing comment this answers). Required when kind='reply'; unused for comments. */
  replyTo?: { parentCommentId: string; threadId?: string };
  /** Current comment body. When pending = the AI suggestion's original text; when edited = after user editing */
  body: string;
  /**
   * Origin: AI suggestion (`finding`) vs user-added manually (`manual`).
   * A draft created by the user from a DiffView line hover '+' is manual; one navigated from ChatPane is finding.
   * A reply-draft is always `manual` (the user authored it).
   */
  origin: 'finding' | 'manual';
  /**
   * Filled only when origin='finding', pointing back to the source finding. The UI uses it on the ChatPane finding card
   * to look up the associated Draft's status chip display
   */
  source?: { runId: string; findingId: string };
  status: 'pending' | 'edited' | 'posted' | 'rejected';
  /** The remote comment id after a successful publish, idempotency key + navigation link */
  posted_remote_id?: string;
  /** ISO */
  createdAt: string;
  /** ISO, refreshed on every update */
  updatedAt: string;
}

export interface ReviewDraftAnchor {
  path: string;
  /** Anchor start line (1-based) */
  startLine: number;
  /** Anchor end line; single-line comment = startLine */
  endLine: number;
  /** Anchor to the base (old) or head (new) side */
  side: 'old' | 'new';
}

export interface DraftsFile {
  schema_version: 1;
  drafts: ReviewDraft[];
}

export interface FindingClosuresFile {
  schema_version: 1;
  closures: FindingClosure[];
}

/**
 * PR identity snapshot: embedded into ReviewRun (optional) so the run file is self-describing, able to look up its owning PR
 * without depending on `prs/index.json`. Needed by the M5 archive scenario (PR already hard-cleared but the run exported separately).
 *
 * This copies `@meebox/poller`'s PrIdentity shape into shared, to avoid shared reverse-depending on
 * poller (circular dependency). Fields correspond one-to-one on both sides.
 */
export interface PrIdentitySnapshot {
  platform: PlatformKind;
  connectionId: string;
  group: string;
  repo: string;
  remoteId: string;
  url?: string;
}

/**
 * The complete record of one pr-agent invocation. Persisted as `state/prs/<localId>/runs/<runId>.json`,
 * in the same directory as the PR's meta.json / comments.json, cleaned up together when the PR leaves.
 */
/**
 * This run's LLM token usage (real values, from API response.usage, captured via a litellm callback,
 * see sitecustomize.py). One run may call the LLM multiple times (retry / multiple tools), so this is the
 * **cumulative** value, with calls recording the number of invocations. May be missing for historical runs / non-embedded / streaming models → all optional.
 */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** The number of LLM invocations captured in this run (the cumulative source) */
  calls?: number;
  /** Prompt cache read (cache_read) token count: part of promptTokens, for the UI to split-display "↑total (cache N)".
   *  The CLI path takes it from claude/codex usage, the API path from litellm (Anthropic cache_read / OpenAI cached_tokens).
   *  Missing or 0 = no cache-hit info (the UI doesn't show that parenthetical). */
  cacheReadTokens?: number;
  /** The model's actual interaction turns: in CLI agentic mode, the num_turns accumulated inside this run (may be far greater than calls);
   *  otherwise falls back to the LLM invocation count (calls). ≤1 the UI doesn't show separately. */
  turns?: number;
}

/** pr-agent run trigger origin: user (manually initiated by the user) / agent (dispatched by orchestration / AutoPilot). */
export type ReviewRunOrigin = 'user' | 'agent';

/**
 * Single-commit review scope: limiting a run's diff to a specific commit's own changes (`parent..sha`),
 * rather than the whole PR. Initiated from the Diff view's commit selector, persisted to ReviewRun for the result card to show a scope badge.
 * A commit with no parent (root) can't be single-commit-bounded, so this scope is not provided.
 */
export interface ReviewRunCommitScope {
  /** Target commit full SHA (worktree head). */
  sha: string;
  /** Target commit's first parent commit SHA (worktree base; single-commit diff = parent..sha). */
  parent: string;
  /** Short SHA for display. */
  abbreviatedSha: string;
  /** Commit subject for display (first line of message). */
  subject: string;
}

export interface ReviewRun {
  /** yyyymmdd-HHmmss-ms sequential id, convenient for listing in reverse filename order */
  id: string;
  /** PR hash localId (12 hex chars), aligned with StoredPullRequest.localId */
  prLocalId: string;
  /**
   * PR identity snapshot (optional); currently M3 doesn't fill it by default, the UI always reads PR info from meta.json.
   * A schema slot reserved for M5 archive: when exporting a single run file, this snapshot lets it look up the remote PR / navigation URL,
   * even after the local `prs/<hash>/` has been hard-cleared
   */
  prIdentitySnapshot?: PrIdentitySnapshot;
  tool: ReviewRunTool;
  /** The question content for the /ask tool; other tools don't fill it. The UI renders it as user speech above the run card */
  question?: string;
  /**
   * Trigger origin: user (a slash command initiated directly by the user in ChatPane) / agent (a sub-run dispatched by orchestration / AutoPilot).
   * ChatPane accordingly adds a command echo bubble above the card for user-origin runs (conversational habit); agent sub-runs are not echoed
   * (their user input is already carried by the orchestration session's user message, avoiding duplicate bubbling). Historical runs lack this field (undefined), not echoed.
   */
  origin?: ReviewRunOrigin;
  /**
   * Single-commit review scope: filled when this run is limited to that commit's own changes (`parent..sha`) rather than the whole PR.
   * Default = whole-PR scope. The result card shows a scope badge accordingly.
   */
  scope?: ReviewRunCommitScope;
  /** The pr-agent version obtained at probe time (CLI first line / the pr-agent version found by the embedded runtime) */
  prAgentVersion: string;
  strategy: PrAgentStrategy;
  /**
   * The LLM model ID used by this run — taken from the active LlmProfile.model at startup (in the form after
   * normalizeModel adds the provider prefix, e.g., `openai/qwen-plus` /
   * `deepseek/deepseek-chat`).
   *
   * Historical runs didn't store this field (undefined), so the UI should handle it gracefully. New runs fill it at the startReviewRun
   * entry, so ChatPane shows in the meta row "which model each review used", making it convenient to review
   * result differences across profiles
   */
  model?: string;
  status: ReviewRunStatus;
  /** ISO start time */
  startedAt: string;
  /** ISO finish time, undefined in the running state */
  finishedAt?: string;
  /** Wall-clock runtime (ms) */
  durationMs?: number;
  /** Process exit code; may be -1 or undefined on timeout / signal kill / spawn failure */
  exitCode?: number;
  errorReason?: ReviewRunFailureReason;
  errorMessage?: string;
  /** Raw stdout text; still kept after M3-B2 parses it into findings, for "see original" debugging */
  stdout?: string;
  /** Raw stderr text */
  stderr?: string;
  /** Parsed findings; filled only for a succeeded run, a failed one may also have some partially */
  findings?: Finding[];
  /** Summary (takes the first ## section title / first description line), shown in the UI list */
  summary?: string;
  /** This run's real LLM token usage (cumulative); missing = not captured (see TokenUsage) */
  tokenUsage?: TokenUsage;
  /**
   * Re-review reference: when this /ask is a "re-review" of a finding from a prior review/improve run, record the referenced source
   * finding (forward link). The UI shows a "re-reviewed from <file:line>" badge + verdict actions on the /ask card accordingly.
   * Filled only when tool='ask' and triggered via "reference".
   */
  referencedFinding?: { runId: string; findingId: string; anchor?: FindingAnchor };
  /**
   * Re-review verdict: parsed from the `<verdict>` section of the re-review /ask output — replace=give a superseding new comment / keep=the original comment holds /
   * drop=the original comment doesn't hold. Drives the UI's accept / close actions. undefined when the model doesn't give one (the UI only displays, no verdict action).
   */
  askVerdict?: AskVerdict;
}

/** Re-review verdict: supersede the original comment / keep the original comment / revoke the original comment. */
export type AskVerdict = 'replace' | 'keep' | 'drop';

/**
 * Finding closure relation: a source finding closed by a re-review /ask "supersede / revoke" (independent of local draft semantics, affecting only
 * the closed state + bidirectional cross-linking of the ChatPane finding card). Identifies the source finding by (runId, findingId).
 */
export interface FindingClosure {
  /** The review/improve run id where the source finding resides */
  runId: string;
  /** The source finding id */
  findingId: string;
  /** The re-review /ask run id that closed it (for card cross-linking) */
  byAskRunId: string;
  /** The verdict that triggered closure (replace=superseded / drop=revoked) */
  verdict: AskVerdict;
  /** ISO closure time */
  createdAt: string;
}

export interface ReviewRunFile {
  schema_version: 1;
  run: ReviewRun;
}

/**
 * The PR as stored in the state store: local dimensions (owning connection, local status, discovery/last-seen time) layered on top of the remote fields.
 * Used both for main-process persistence and as the shape the renderer receives via IPC.
 */
export interface StoredPullRequest extends PullRequest {
  /**
   * The PR's unique identifier in the local state system: sha1(platform|connectionId|group|repo|remoteId)
   * taking the first 12 hex chars. See `@meebox/poller`'s `prHashId` for details.
   *
   * Using a hash instead of concatenating strings:
   * - path-friendly (no `:` `/` needing escaping, consistent across platforms)
   * - fixed length (12 chars)
   * - the same PR id across different platform / repo won't collide (platform + group + repo + remote are all in the hash source)
   */
  localId: string;
  /**
   * The remote platform type. Makes a single meta.json self-describing, able to know which platform this PR
   * comes from without depending on prs/index.json — friendly for cross-storage migration / backup / offline analysis. Bitbucket only since M3; no schema change needed when integrating
   * GitHub / GitLab in M5
   */
  platform: PlatformKind;
  connectionId: string;
  localStatus: LocalPrStatus;
  /**
   * The discovery categories this PR matched (GitHub: a subset of review-requested/created/assigned/mentioned).
   * In one round the poller fetches all categories and union-tags them; the renderer filters tabs locally accordingly, and switching no longer hits the remote.
   * An empty array for platforms that don't support categories (Bitbucket).
   */
  discoveryFilters: PrDiscoveryFilter[];
  /** Time first discovered by poll, ISO */
  discoveredAt: string;
  /** Time most recently still seen by a poll, ISO */
  lastSeenAt: string;
  /**
   * "Unread" marker (derived value, filled by `listStoredPullRequests` after computing against the read watermark in the index; the persisted meta.json
   * doesn't contain this field). True means a new event **relevant to me** has occurred since the user last viewed this PR: the source branch pushed a new commit, or
   * new comments @-ing me / replying to me appeared. The UI shows an unread dot on the list item accordingly. Opening the PR clears it (advancing the read watermark).
   */
  unread?: boolean;
  /**
   * "@me / reply to me" unread comment count (derived value, like `unread` filled by `listStoredPullRequests` computing against the read watermark, not in meta.json).
   * **Coexists with, does not replace** the unread dot: the dot still lights up on new arrival / new commit / named reply as usual; this count only additionally gives the count of unread comments naming/replying to you.
   * Already capped at 10 on the poll side, so ≤ 10; the UI shows "10+" when full. 0 means no such unread (the count isn't rendered).
   */
  unreadMentionCount?: number;
}

export interface PollResult {
  /** Total number of PRs returned across all connections in this round */
  fetched: number;
  /** Number of PRs changed vs the last updatedAt */
  changed: number;
  /** Number of PRs added this round */
  added: number;
  /** Number of PRs pruned this round (already merged/declined on the remote, or the current user is no longer a reviewer) */
  removed: number;
  /** Number of connections that failed to poll */
  errors: number;
}

/**
 * System notification event types (one-to-one with the settings page toggles):
 * - `new_pr` / `mention` / `reply`: for "review-requested" etc. — new PR / being @-ed / being replied to.
 * - `authored_comment` / `authored_needs_work` / `authored_conflict`: for "authored by me" PRs (self is the author) —
 *   receiving a new comment from others / being marked needs-work by a reviewer / a merge conflict appearing.
 */
export type PollNotificationKind =
  | 'new_pr'
  | 'mention'
  | 'reply'
  | 'authored_comment'
  | 'authored_needs_work'
  | 'authored_conflict';

/**
 * A "worth notifying" event newly occurring in this poll round, projected by the poller to the main process via onNotify (for popping system notifications). Produced only when there is **an existing baseline**
 * (not the first round / the PR was previously known), to avoid a notification storm on first launch / batch influx; cursor-bearing events (mention/reply/authored_comment)
 * count only when the comment time is later than the historical cursor; authored_needs_work / authored_conflict are produced only on a new transition of the corresponding status.
 */
export interface PollNotificationEvent {
  kind: PollNotificationKind;
  /** The local id of the PR the event belongs to */
  localId: string;
  /** The connection id the event belongs to (avatar cache key + for taking the adapter to fetch the avatar) */
  connectionId: string;
  /** Remote PR number (such as #123), for the notification body */
  remoteId: string;
  /** PR title, for the notification body */
  title: string;
  /** The repo the PR is in, for the notification body to show "project / repo" */
  repo: RepoRef;
  /**
   * Initiator (notification avatar): new_pr=PR author; mention/reply/authored_comment=the author of the latest comment triggering this round's event of that type;
   * authored_needs_work=the reviewer who newly marked needs-work; authored_conflict=PR author (no specific initiator).
   */
  actor: PlatformUser;
  /** mention / reply / authored_comment: the count added this round; omitted otherwise */
  count?: number;
  /**
   * Locating info of the latest comment that triggered the event (for notification click navigation). `anchor` non-null=inline comment (can jump to a diff line),
   * null=summary comment (opens the "activity" conversation tab). Only mention / reply / authored_comment carry this field.
   */
  comment?: { remoteId: string; anchor: PrCommentAnchor | null };
}
