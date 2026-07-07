import { lazy, Suspense, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlatformUser, PrComment, PrCommentAnchor, StoredPullRequest } from '@meebox/shared';
import i18n from '../../../../../i18n';
import { formatDate, formatTimestamp } from '../../../../../utils/time';
import {
  Avatar,
  makeBitbucketImageFor,
  ChatIcon,
  ConfirmModal,
  mermaidComponents,
} from '../../../../common';
import { CommentEditEditor } from './CommentEditEditor';
import { CommentReplyEditor } from './CommentReplyEditor';
import { CommentMarkdown } from '../shared/CommentMarkdown';
import { ReactionAddButton, ReactionChips, useReactions } from '../shared/ReactionBar';
import { useCommentThread } from '../shared/useCommentThread';
// Inline code context uses Monaco; lazy-loaded and pulled on demand with the same Monaco chunk as DiffView, not in the entry bundle.
const InlineCodeContext = lazy(() =>
  import('./InlineCodeContext').then((m) => ({ default: m.InlineCodeContext })),
);

/**
 * Structural equality comparison of the comment tree (by remoteId + body + version + edit/delete permissions + recursive replies). poll mostly returns
 * comments with unchanged content: on equality, skip setState and keep the old reference so React bails out, avoiding pointless re-render of the whole
 * comment tree (including inline Monaco) (refresh flicker).
 */
export function sameCommentList(a: readonly PrComment[], b: readonly PrComment[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.remoteId !== y.remoteId ||
      x.body !== y.body ||
      x.version !== y.version ||
      x.canEdit !== y.canEdit ||
      x.canDelete !== y.canDelete ||
      !sameReactions(x.reactions, y.reactions) ||
      !sameCommentList(x.replies, y.replies)
    ) {
      return false;
    }
  }
  return true;
}

/** Equality comparison of the reactions array (emoji + count + mine triple matching item by item): lets reaction changes after a toggle trigger a re-render. */
function sameReactions(a: PrComment['reactions'], b: PrComment['reactions']): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    if (x[i]!.emoji !== y[i]!.emoji || x[i]!.count !== y[i]!.count || x[i]!.mine !== y[i]!.mine) {
      return false;
    }
  }
  return true;
}

/**
 * Maximum indent level for nested replies: past this level recursion continues but **no further indent is added** (flattened display), avoiding
 * deep nesting squeezing content into a very narrow right side. depth 0 is the top-level comment; depth 1..MAX indent progressively, and deeper replies
 * beyond MAX are all laid flat at the MAX-level indent, still readable by author attribution. Bitbucket actually has only one reply level, while GitHub / GitLab can nest deeply, hence the cap.
 */
const MAX_REPLY_DEPTH = 5;

/**
 * A single comment + nested replies. inline comments show a `path:line side` chip at the top to distinguish the anchor location;
 * summary comments carry no chip. replies recurse, with depth controlling the left indent; past MAX_REPLY_DEPTH levels they flatten
 * (no further indent, see that constant).
 *
 * In `timeline` mode (activity timeline, GitHub/Bitbucket), the **top-level comment** switches to the timeline-row layout: a header unified with other events
 * ("comment icon + avatar + bold author name + 'commented' verb + time"), with the body indented as a whole into a card hung on the timeline rail.
 * Non-timeline (GitLab pure comment view) or replies (depth>0) keep the original card layout.
 */
export function CommentItem({
  comment,
  pr,
  depth,
  autoExpandCode = false,
  hardBreaks,
  reactionsMode,
  mentionCandidates,
  attachmentsEnabled = false,
  userSearchEnabled = false,
  timeline = false,
  readOnly = false,
  onJumpToAnchor,
}: {
  comment: PrComment;
  pr: StoredPullRequest;
  depth: number;
  /** Top-level (depth=0) is decided true/false by the parent per CAP; replies are always false (do not render code) */
  autoExpandCode?: boolean;
  hardBreaks: boolean;
  /** Comment emoji reaction mode (capabilities.commentReactions): renders only for 'fixed'/'free'; absent = unsupported. */
  reactionsMode?: 'fixed' | 'free';
  /** `@mention` autocomplete candidates (PR participants + comment authors); passed through to the reply editor. */
  mentionCandidates?: PlatformUser[];
  /** Whether the platform supports image attachment upload (capabilities.commentAttachments); passed through to the reply editor to enable paste upload. */
  attachmentsEnabled?: boolean;
  /** Whether the platform supports remote user search (capabilities.userSearch); passed through to the reply editor for the mention remote fallback. */
  userSearchEnabled?: boolean;
  /** Whether in activity timeline mode (only affects top-level comment layout, see the note above) */
  timeline?: boolean;
  /** Content read-only (decline / non-participable archived PR): hides reply / edit / delete actions, browse only. */
  readOnly?: boolean;
  /** Clicking the inline comment anchor chip → jump to the corresponding file/line in the Diff. When provided, the chip becomes clickable. */
  onJumpToAnchor?: (anchor: PrCommentAnchor) => void;
}) {
  const { t } = useTranslation();
  // Images embedded in the comment body go through the IPC proxy (Bitbucket private resources need PAT auth)
  const mdComponents = useMemo(
    () => ({ ...mermaidComponents, img: makeBitbucketImageFor(pr.localId, pr.url) }),
    [pr.localId, pr.url],
  );
  // Reply / edit / delete interaction state machine (shared with the diff inline comment zone, see shared/useCommentThread)
  const {
    replyOpen,
    setReplyOpen,
    editOpen,
    setEditOpen,
    confirmDelete,
    setConfirmDelete,
    deleting,
    deleteError,
    setDeleteError,
    canEdit,
    canDelete,
    handleDelete,
  } = useCommentThread(pr.localId, comment);

  // Reaction state + toggle (hook called unconditionally; output rendered only when reactionsMode exists).
  const { reactions, busy: reactionBusy, toggle: toggleReaction } = useReactions(
    pr.localId,
    comment,
    readOnly,
  );

  // inline comment anchor chip: path:line + side (old=base / new=head), letting the user locate the code position from the comment.
  // When onJumpToAnchor is provided (activity view) the chip becomes clickable → jump to the corresponding file/line in the Diff.
  const anchor = comment.anchor;
  const anchorChip = anchor ? (
    onJumpToAnchor ? (
      <button
        type="button"
        className={`pr-comment-anchor pr-comment-anchor-${anchor.side} pr-comment-anchor-link`}
        onClick={() => onJumpToAnchor(anchor)}
        title={t('commentsPanel.anchorJumpTitle')}
      >
        <code>{anchor.path}</code>:{anchor.line}
      </button>
    ) : (
      <span
        className={`pr-comment-anchor pr-comment-anchor-${anchor.side}`}
        title={t('commentsPanel.anchorTitle', {
          side: anchor.side === 'old' ? 'base' : 'head',
          lineType: anchor.lineType,
        })}
      >
        <code>{anchor.path}</code>:{anchor.line}
      </span>
    )
  ) : null;

  // inline comment: embed a code context (Monaco read-only) above the body. replies (depth > 0) do not repeat it.
  const inlineCode =
    comment.anchor && depth === 0 ? (
      <Suspense
        fallback={<div className="pane-loading muted">{t('commentsPanel.loadingCodeContext')}</div>}
      >
        <InlineCodeContext pr={pr} anchor={comment.anchor} autoExpand={autoExpandCode} />
      </Suspense>
    ) : null;

  // Edit mode: textarea replaces the markdown body in place; non-edit mode: render markdown
  const bodyOrEdit =
    editOpen && typeof comment.version === 'number' ? (
      <CommentEditEditor
        prLocalId={pr.localId}
        commentId={comment.remoteId}
        version={comment.version}
        initialBody={comment.body}
        onCancel={() => setEditOpen(false)}
        onSaved={() => setEditOpen(false)}
      />
    ) : (
      <CommentMarkdown
        body={comment.body}
        hardBreaks={hardBreaks}
        components={mdComponents}
        className="pr-comment-body markdown"
      />
    );

  // Action row: edit mode hides all buttons (avoiding duplication with the editor's bottom button group); read-only (decline / non-participable) hides the whole row.
  const foot = !editOpen && !readOnly ? (
    <div className="pr-comment-foot">
      {!replyOpen && (
        <button type="button" className="pr-comment-reply-btn" onClick={() => setReplyOpen(true)}>
          {t('commentsPanel.reply')}
        </button>
      )}
      {canEdit && !replyOpen && (
        <button
          type="button"
          className="pr-comment-edit-btn"
          onClick={() => setEditOpen(true)}
          title={t('commentsPanel.editTitle')}
        >
          {t('common.edit')}
        </button>
      )}
      {/* Delete button last, aligned in style with the other buttons — while disabled the label becomes "deleting…" */}
      {canDelete && !replyOpen && (
        <button
          type="button"
          className="pr-comment-delete-btn"
          onClick={() => setConfirmDelete(true)}
          disabled={deleting}
          title={t('commentsPanel.deleteTitle')}
        >
          {deleting ? t('commentsPanel.deleting') : t('common.delete')}
        </button>
      )}
      {/* The "add reaction" button goes after the action buttons; hidden in reply edit mode to avoid crowding */}
      {reactionsMode && !replyOpen && (
        <ReactionAddButton
          reactions={reactions}
          busy={reactionBusy}
          mode={reactionsMode}
          onToggle={toggleReaction}
        />
      )}
    </div>
  ) : null;

  const deleteErrorEl = deleteError ? (
    <div className="pr-comment-delete-error" role="alert">
      {t('commentsPanel.deleteFailed', { msg: deleteError })}
      <button
        type="button"
        className="pr-comment-delete-error-dismiss"
        onClick={() => setDeleteError(null)}
        aria-label={t('commentsPanel.dismissErrorAria')}
        title={t('commentsPanel.dismissErrorTitle')}
      >
        ✕
      </button>
    </div>
  ) : null;

  // Existing reactions: on their own row, rendered below the action button row (hidden in edit mode). Under readOnly they only display, not toggle.
  const reactionChipsEl =
    reactionsMode && !editOpen ? (
      <ReactionChips
        reactions={reactions}
        busy={reactionBusy}
        readOnly={readOnly}
        onToggle={toggleReaction}
      />
    ) : null;

  const replyEditor = replyOpen ? (
    <CommentReplyEditor
      prLocalId={pr.localId}
      // Reply target abstraction (threadId): GitLab=discussion id (required for reply); Bitbucket empty / GitHub=remoteId → fall back to remoteId.
      parentCommentId={comment.threadId ?? comment.remoteId}
      mentionCandidates={mentionCandidates}
      platform={pr.platform}
      attachmentsEnabled={attachmentsEnabled}
      userSearchEnabled={userSearchEnabled}
      onCancel={() => setReplyOpen(false)}
      onPosted={() => setReplyOpen(false)}
    />
  ) : null;

  const repliesEl =
    comment.replies.length > 0 ? (
      // Past MAX_REPLY_DEPTH levels, use pr-comments-flat instead of pr-comments-replies (no more indent / left border) →
      // deeper replies flatten at that indent level; pr-comments-flat accordingly adds a horizontal divider between adjacent same-level comments to distinguish them.
      <ul
        className={`pr-comments-list ${depth < MAX_REPLY_DEPTH ? 'pr-comments-replies' : 'pr-comments-flat'}`}
      >
        {comment.replies.map((r) => (
          <CommentItem
            key={r.remoteId}
            comment={r}
            pr={pr}
            depth={depth + 1}
            hardBreaks={hardBreaks}
            reactionsMode={reactionsMode}
            mentionCandidates={mentionCandidates}
            attachmentsEnabled={attachmentsEnabled}
            userSearchEnabled={userSearchEnabled}
            readOnly={readOnly}
            onJumpToAnchor={onJumpToAnchor}
          />
        ))}
      </ul>
    ) : null;

  const confirmModalEl = confirmDelete ? (
    <ConfirmModal
      title={t('commentsPanel.deleteConfirmTitle')}
      message={t('commentsPanel.deleteConfirmMessage')}
      confirmLabel={t('common.delete')}
      cancelLabel={t('common.cancel')}
      danger
      onConfirm={() => void handleDelete()}
      onCancel={() => setConfirmDelete(false)}
    />
  ) : null;

  // Top-level comment in timeline mode: a header row unified with other events (icon + avatar + author + 'commented' + time), with the body hung as an indented card.
  if (timeline && depth === 0) {
    return (
      <li className="pr-comment pr-comment-timeline pr-comment-depth-0">
        <div className="pr-activity-item pr-activity-comment-head">
          <span className="pr-activity-icon pr-activity-icon-comment" aria-hidden="true">
            <ChatIcon size={18} />
          </span>
          <Avatar
            connectionId={pr.connectionId}
            slug={comment.author.slug ?? comment.author.name}
            displayName={comment.author.displayName}
            avatarUrl={comment.author.avatarUrl}
            size={22}
          />
          <div className="pr-activity-main">
            <span className="pr-activity-actor">{comment.author.displayName}</span>
            <span className="pr-activity-verb">{t('activityPanel.verb.commented')}</span>
            {anchorChip}
          </div>
          <time
            className="pr-activity-time muted time-tip"
            dateTime={comment.createdAt}
            data-tip={formatExactTime(comment.createdAt)}
          >
            {formatRelativeTime(comment.createdAt)}
          </time>
        </div>
        <div className="pr-comment-card">
          {inlineCode}
          {bodyOrEdit}
          {foot}
          {reactionChipsEl}
          {deleteErrorEl}
          {replyEditor}
          {repliesEl}
        </div>
        {confirmModalEl}
      </li>
    );
  }

  return (
    <li className={`pr-comment pr-comment-depth-${String(Math.min(depth, MAX_REPLY_DEPTH))}`}>
      <div className="pr-comment-head">
        <Avatar
          connectionId={pr.connectionId}
          slug={comment.author.slug ?? comment.author.name}
          displayName={comment.author.displayName}
          avatarUrl={comment.author.avatarUrl}
          size={22}
        />
        <span className="pr-comment-author">{comment.author.displayName}</span>
        {anchorChip}
        <time
          className="pr-comment-time muted time-tip"
          dateTime={comment.createdAt}
          data-tip={formatExactTime(comment.createdAt)}
        >
          {formatRelativeTime(comment.createdAt)}
        </time>
      </div>
      {inlineCode}
      {bodyOrEdit}
      {foot}
      {reactionChipsEl}
      {deleteErrorEl}
      {replyEditor}
      {repliesEl}
      {confirmModalEl}
    </li>
  );
}

/**
 * Exact local time (`yyyy-mm-dd HH:mm:ss`, always with the date) for the time label's hover tooltip — the
 * tooltip's whole job is precise disambiguation, so it never omits the date.
 */
export function formatExactTime(iso: string): string {
  return formatTimestamp(iso, { full: true });
}

/**
 * Relative time text (just now / N minutes ago / …), falling back to the local date beyond a week. Shared by comments and activity events.
 */
export function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return i18n.t('commentsPanel.justNow');
  if (diffSec < 3600)
    return i18n.t('commentsPanel.minutesAgo', { count: Math.round(diffSec / 60) });
  if (diffSec < 86400)
    return i18n.t('commentsPanel.hoursAgo', { count: Math.round(diffSec / 3600) });
  if (diffSec < 86400 * 7)
    return i18n.t('commentsPanel.daysAgo', { count: Math.round(diffSec / 86400) });
  return formatDate(t);
}
