import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PlatformCapabilities,
  PlatformUser,
  PrActivityEvent,
  PrActivityKind,
  PrComment,
  PrCommentAnchor,
  PrCommit,
  StoredPullRequest,
} from '@meebox/shared';
import { invoke, subscribe } from '../../../../../api';
import { formatBackendError, type FormattedError } from '../../../../../errors';
import {
  Avatar,
  ApproveIcon,
  ChatIcon,
  CloseIcon,
  CommitIcon,
  NeedsWorkIcon,
  PaneLoading,
} from '../../../../common';
import { CommentComposer } from '../comments/CommentComposer';
import {
  CommentItem,
  formatExactTime,
  formatRelativeTime,
  sameCommentList,
} from '../comments/CommentItem';

interface ActivityPanelProps {
  pr: StoredPullRequest;
  /** Callback after the top-level comment count (excluding replies) is fetched successfully, for the parent's tab badge */
  onCommentsLoaded?: (count: number) => void;
  /** Active connection capability flags; here commentHardBreaks decides whether comments enable remark-breaks. */
  capabilities?: PlatformCapabilities;
  /** Content is read-only (declined / non-participable archived PR): hides comment reply / edit / delete and the new composer. */
  readOnly?: boolean;
  /** Whether the "new comment" composer is expanded (controlled by the tab bar's "Comment" button, appears at the top of the timeline) */
  composing?: boolean;
  /** Callback when the new comment composer collapses (cancel / posted successfully) */
  onComposeClose?: () => void;
  /** Current PAT username (used for the new comment composer's avatar) */
  currentUserName?: string | null;
  /** Click a commit event on the timeline → render that commit's changes locally in the Diff tab (no longer opens browser) */
  onViewCommit?: (commit: PrCommit) => void;
  /** Click an inline comment anchor chip → jump to the corresponding file/line in the Diff */
  onJumpToAnchor?: (anchor: PrCommentAnchor) => void;
}

/** The three data streams + their paired PR are frozen together, a stable reference across polls, giving the comment tree (including inline Monaco) a stable identity to avoid re-renders. */
interface ActivityView {
  pr: StoredPullRequest;
  comments: PrComment[];
  commits: PrCommit[];
  activity: PrActivityEvent[];
}

/** Compares lists item by item by id (order-sensitive). commits use sha, activity uses remoteId; if equal, skip setState to let React bail. */
function sameIds<T>(a: readonly T[], b: readonly T[], id: (x: T) => string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (id(a[i]!) !== id(b[i]!)) return false;
  }
  return true;
}

/**
 * PR activity timeline (evolved from the former "Comments" tab). Merges the three data streams by time into one timeline:
 *   1. Comments (summary + inline, including replies / edit / delete / inline code, reusing {@link CommentItem})
 *   2. Commit updates ({@link PrCommit})
 *   3. Reviewer review-decision events (approve / needs-work / unapprove / dismiss, {@link PrActivityEvent})
 *
 * Ordering follows the comments page rule: **reverse chronological (newest first)**, latest activity on top. The comment
 * data source is the same as DiffView's inline comments (`diff:listComments`, the main side has a pr_updated_at cache);
 * commits / decisions each go through their own IPC, both being additive info, and a standalone failure doesn't affect the
 * comment timeline (catch degrades to empty).
 *
 * Switching PRs doesn't clear immediately (stale-while-loading): the old timeline keeps rendering with a loading overlay
 * on top, and once new data is ready it's replaced wholesale, eliminating the "flash loading then render new" gap.
 */
export function ActivityPanel({
  pr,
  onCommentsLoaded,
  capabilities,
  readOnly = false,
  composing = false,
  onComposeClose,
  currentUserName,
  onViewCommit,
  onJumpToAnchor,
}: ActivityPanelProps) {
  // Comment line breaks: GitHub/Bitbucket hard-break; GitLab CommonMark soft break. Defaults to true.
  const hardBreaks = capabilities?.commentHardBreaks ?? true;
  // Comment emoji reaction mode: 'fixed' (GitHub's 8) / 'free' (GitLab/Bitbucket curated set + search); false/default = off.
  const reactionsMode = capabilities?.commentReactions || undefined;
  // Image attachment upload: enables comment paste-to-upload when the platform supports it. Conservatively off by default (GitHub has no upload API, also false).
  const attachmentsEnabled = capabilities?.commentAttachments ?? false;
  // Differentiation: GitHub/Bitbucket render the activity timeline of comments+commits+decisions; GitLab (activityTimeline=false) degrades to
  // a pure comment view (doesn't fetch commits/decisions, keeps the "Comments" wording). Default (capabilities not yet arrived) conservatively treats as pure comments.
  const showTimeline = capabilities?.activityTimeline ?? false;
  // Text namespace: timeline mode uses activityPanel.*, pure comment mode keeps commentsPanel.* (preserving GitLab's original experience).
  const ns = showTimeline ? 'activityPanel' : 'commentsPanel';
  const { t } = useTranslation();
  const [view, setView] = useState<ActivityView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FormattedError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const fetchAll = async (): Promise<void> => {
      try {
        // Comments are core (failure = whole-block error); commits / decisions are additive, standalone failures catch to empty, and the timeline still shows comments.
        // Pure comment mode (GitLab) skips fetching commits / decisions.
        const [comments, commits, activity] = await Promise.all([
          invoke('diff:listComments', { localId: pr.localId, force: true }),
          showTimeline
            ? invoke('diff:listCommits', { localId: pr.localId }).catch(() => [] as PrCommit[])
            : Promise.resolve([] as PrCommit[]),
          showTimeline
            ? invoke('diff:listActivity', { localId: pr.localId }).catch(
                () => [] as PrActivityEvent[],
              )
            : Promise.resolve([] as PrActivityEvent[]),
        ]);
        if (cancelled) return;
        // All three streams equal last time: keep the old view reference to let React bail (don't re-render the timeline when a poll has no substantive change).
        setView((prev) =>
          prev &&
          prev.pr.localId === pr.localId &&
          sameCommentList(prev.comments, comments) &&
          sameIds(prev.commits, commits, (c) => c.sha) &&
          sameIds(prev.activity, activity, (a) => a.remoteId)
            ? prev
            : { pr, comments, commits, activity },
        );
        setLoading(false);
        onCommentsLoaded?.(comments.length);
      } catch (e) {
        if (!cancelled) {
          setError(formatBackendError(e));
          setLoading(false);
        }
      }
    };
    void fetchAll();
    // After the user replies / edits / deletes / posts a draft, main broadcasts comments:changed → refetch
    const unsub = subscribe('comments:changed', (e) => {
      if (e.localId === pr.localId) void fetchAll();
    });
    return () => {
      cancelled = true;
      unsub();
    };
    // onCommentsLoaded deliberately left out of deps: the parent passes a new ref on every render, which would trigger a spurious refetch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr.localId, showTimeline]);

  const viewPr = view?.pr;
  // Cap on auto-mounting Monaco for inline comments: the first N inline comments (after sorting by createdAt descending) mount directly; the rest use click-to-expand.
  // Take 10 to match the comments page — roughly viewable within one screen, beyond that requires active expansion.
  const autoExpandSet = useMemo(() => {
    const out = new Set<string>();
    const inlineByNewest = (view?.comments ?? [])
      .filter((c) => c.anchor)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (let i = 0; i < inlineByNewest.length && i < 10; i++) out.add(inlineByNewest[i]!.remoteId);
    return out;
  }, [view]);

  // @mention candidates: derived from loaded comment authors (including replies) + commit authors — bounded, zero extra fetches, safe (only this PR's participants,
  // not enumerating everyone from the remote). Independent of whether the platform supports reaction/mention enhancements, purely additive; the user can still freely type any @name.
  const mentionCandidates = useMemo<PlatformUser[]>(
    () => collectMentionCandidates(view?.comments ?? [], view?.commits ?? []),
    [view],
  );

  // Merge the three streams into timeline entries sorted in reverse chronological order. deps are all stable references (view stays unchanged after the three-stream equality comparison above skips it,
  // autoExpandSet follows view) → when a poll has no change, the whole timeline (including inline Monaco) keeps element identity and React skips re-rendering.
  const timeline = useMemo<ReactElement[]>(() => {
    if (!viewPr || !view) return [];
    type Row = { key: string; at: number; node: ReactElement };
    const rows: Row[] = [];
    for (const c of view.comments) {
      rows.push({
        key: `comment:${c.remoteId}`,
        at: Date.parse(c.createdAt) || 0,
        node: (
          <CommentItem
            key={`comment:${c.remoteId}`}
            comment={c}
            pr={viewPr}
            depth={0}
            autoExpandCode={autoExpandSet.has(c.remoteId)}
            hardBreaks={hardBreaks}
            reactionsMode={reactionsMode}
            mentionCandidates={mentionCandidates}
            attachmentsEnabled={attachmentsEnabled}
            timeline={showTimeline}
            readOnly={readOnly}
            onJumpToAnchor={onJumpToAnchor}
          />
        ),
      });
    }
    for (const cm of view.commits) {
      rows.push({
        key: `commit:${cm.sha}`,
        at: Date.parse(cm.committedAt || cm.authoredAt) || 0,
        node: (
          <CommitEvent key={`commit:${cm.sha}`} commit={cm} pr={viewPr} onView={onViewCommit} />
        ),
      });
    }
    for (const ev of view.activity) {
      rows.push({
        key: `review:${ev.remoteId}`,
        at: Date.parse(ev.createdAt) || 0,
        node: <ReviewEvent key={`review:${ev.remoteId}`} event={ev} pr={viewPr} />,
      });
    }
    // newest first; under a stable sort, same-instant entries are ordered by enqueue order: comment→commit→decision
    rows.sort((a, b) => b.at - a.at);
    return rows.map((r) => r.node);
  }, [
    view,
    viewPr,
    autoExpandSet,
    hardBreaks,
    reactionsMode,
    mentionCandidates,
    attachmentsEnabled,
    showTimeline,
    readOnly,
    onViewCommit,
    onJumpToAnchor,
  ]);

  // First-load failure / PR-switch failure (no trustworthy content to show, or the existing view belongs to an old PR): whole-block error, don't pass off old PR content as the new one.
  if (error && (!view || view.pr.localId !== pr.localId)) {
    return (
      <div className="pr-comments-panel">
        <div className="pr-comments-scroll">
          <div className="pr-comments-error" role="alert">
            <strong>{t(`${ns}.loadError`, { title: error.title })}</strong>
            <pre>{error.detail}</pre>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pr-comments-panel">
      <div className="pr-comments-scroll">
        {(composing || (view && timeline.length > 0)) && (
          <ul className="pr-comments-list pr-activity-list">
            {/* The new comment composer as the first node of the timeline: same icon node + avatar as other entries, the composer indented and mounted on the rail. */}
            {composing && !readOnly && (
              <li className="pr-comment pr-comment-timeline pr-comment-depth-0">
                <div className="pr-activity-item pr-activity-comment-head">
                  <span className="pr-activity-icon pr-activity-icon-comment" aria-hidden="true">
                    <ChatIcon size={18} />
                  </span>
                  <Avatar
                    connectionId={pr.connectionId}
                    slug={currentUserName ?? ''}
                    displayName={currentUserName ?? ''}
                    size={22}
                  />
                </div>
                <div className="pr-activity-compose-card">
                  <CommentComposer
                    prLocalId={pr.localId}
                    mentionCandidates={mentionCandidates}
                    attachmentsEnabled={attachmentsEnabled}
                    onCancel={() => onComposeClose?.()}
                    onPosted={() => onComposeClose?.()}
                  />
                </div>
              </li>
            )}
            {view ? timeline : null}
          </ul>
        )}
        {view && timeline.length === 0 && !composing && !loading && (
          <p className="muted">{t(`${ns}.empty`)}</p>
        )}
      </div>
      {/* The loading overlay covers the old content (or the empty panel on first load), replaced wholesale once ready. PaneLoading defaults to delayMs=150:
          for cache-hit fast switches the overlay never appears and the old content swaps directly to new (zero flash); only slow loads show a spinner. */}
      {loading && <PaneLoading overlay label={t(`${ns}.loading`)} />}
    </div>
  );
}

/**
 * Derives @mention candidate users from loaded comments (recursing into replies) + commits: dedup by name, order-preserving. The candidate source deliberately takes only
 * participants who already appear in this PR (bounded, zero extra fetches, doesn't enumerate everyone from the remote), a safe data source for @ autocomplete.
 */
function collectMentionCandidates(comments: PrComment[], commits: PrCommit[]): PlatformUser[] {
  const seen = new Set<string>();
  const out: PlatformUser[] = [];
  const push = (u: PlatformUser | undefined): void => {
    if (!u?.name || seen.has(u.name)) return;
    seen.add(u.name);
    out.push(u);
  };
  const walk = (list: PrComment[]): void => {
    for (const c of list) {
      push(c.author);
      if (c.replies.length > 0) walk(c.replies);
    }
  };
  walk(comments);
  for (const cm of commits) {
    push(cm.author);
    push(cm.committer);
  }
  return out;
}

/** A commit event on the timeline: commit icon + short SHA + subject + author + time; clickable to jump to the remote commit page. */
function CommitEvent({
  commit,
  pr,
  onView,
}: {
  commit: PrCommit;
  pr: StoredPullRequest;
  onView?: (commit: PrCommit) => void;
}) {
  const { t } = useTranslation();
  const isMerge = commit.parents.length > 1;
  const subject = commit.message.split('\n', 1)[0]!;
  return (
    <li
      className={`pr-activity-item pr-activity-commit ${onView ? 'pr-activity-clickable' : ''}`}
      onClick={() => onView?.(commit)}
      title={commit.message}
    >
      <span className="pr-activity-icon pr-activity-icon-commit" aria-hidden="true">
        <CommitIcon size={18} />
      </span>
      {/* Author display aligns with the comment's main person: same-size avatar + bold name, no differentiation */}
      <Avatar
        connectionId={pr.connectionId}
        slug={commit.author.slug ?? commit.author.name}
        displayName={commit.author.displayName}
        avatarUrl={commit.author.avatarUrl}
        size={22}
      />
      <div className="pr-activity-main">
        <span className="pr-activity-actor">{commit.author.displayName}</span>
        <span className="pr-activity-commit-subject">{subject}</span>
        {isMerge && (
          <span
            className="pr-activity-merge-tag"
            title={t('activityPanel.mergeCommit', { parents: commit.parents.length })}
          >
            merge
          </span>
        )}
        <code className="pr-activity-sha">{commit.abbreviatedSha}</code>
      </div>
      <time
        className="pr-activity-time muted time-tip"
        dateTime={commit.committedAt}
        data-tip={formatExactTime(commit.committedAt || commit.authoredAt)}
      >
        {formatRelativeTime(commit.committedAt || commit.authoredAt)}
      </time>
    </li>
  );
}

/** kind → icon + semantic color class. approved green, needsWork amber, unapproved/dismissed neutral. */
const REVIEW_ICON: Record<PrActivityKind, ReactElement> = {
  approved: <ApproveIcon size={18} />,
  needsWork: <NeedsWorkIcon size={18} />,
  unapproved: <CloseIcon size={18} />,
  dismissed: <CloseIcon size={18} />,
};

/** A review-decision event on the timeline: actor + decision verb + time. */
function ReviewEvent({ event, pr }: { event: PrActivityEvent; pr: StoredPullRequest }) {
  const { t } = useTranslation();
  return (
    <li className={`pr-activity-item pr-activity-review pr-activity-review-${event.kind}`}>
      <span className={`pr-activity-icon pr-activity-icon-${event.kind}`} aria-hidden="true">
        {REVIEW_ICON[event.kind]}
      </span>
      <Avatar
        connectionId={pr.connectionId}
        slug={event.actor.slug ?? event.actor.name}
        displayName={event.actor.displayName}
        avatarUrl={event.actor.avatarUrl}
        size={22}
      />
      <div className="pr-activity-main">
        <span className="pr-activity-actor">{event.actor.displayName}</span>
        <span className={`pr-activity-chip pr-activity-chip-${event.kind}`}>
          {t(`activityPanel.verb.${event.kind}`)}
        </span>
      </div>
      <time
        className="pr-activity-time muted time-tip"
        dateTime={event.createdAt}
        data-tip={formatExactTime(event.createdAt)}
      >
        {formatRelativeTime(event.createdAt)}
      </time>
    </li>
  );
}
