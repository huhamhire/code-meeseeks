import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type ReactMarkdown from 'react-markdown';
import type { PrComment } from '@meebox/shared';
import { Avatar, makeBitbucketImageFor, ConfirmModal } from '../../../../../common';
import { formatTimestamp } from '../../../../../../utils/time';
import { CommentEditEditor } from '../../comments/CommentEditEditor';
import { CommentReplyEditor } from '../../comments/CommentReplyEditor';
import { CommentMarkdown } from '../../shared/CommentMarkdown';
import { ReactionAddButton, ReactionChips, useReactions } from '../../shared/ReactionBar';
import { useCommentThread } from '../../shared/useCommentThread';

/**
 * Estimate view zone height (in lines). Each comment = header(avatar+name+date, 1.3 lines) + body
 * length / 80 rounded up. Replies computed recursively, each reply adds 0.3 line (margin/border).
 * Multiple comments on the same line stack, capped at 32 lines to avoid hogging the screen.
 */
export function estimateZoneHeight(comments: PrComment[]): number {
  let h = 1; // top/bottom padding
  for (const c of comments) h += commentHeight(c) + 0.3; // separator between items
  return Math.min(Math.ceil(h), 32);
}

function commentHeight(c: PrComment): number {
  let h = 1.3 + Math.max(1, Math.ceil(c.body.length / 80));
  for (const r of c.replies) h += commentHeight(r) + 0.3;
  return h;
}

export function CommentZone({
  comments,
  connectionId,
  attachmentBase,
  prLocalId,
  prWebUrl,
  hardBreaks,
  reactionsMode,
  attachmentsEnabled = false,
  readOnly = false,
}: {
  comments: PrComment[];
  connectionId: string;
  attachmentBase: string | null;
  prLocalId: string;
  prWebUrl: string;
  hardBreaks: boolean;
  /** Comment emoji reaction mode (capabilities.commentReactions): only 'fixed'/'free' render the add-reaction button; absent = unsupported. */
  reactionsMode?: 'fixed' | 'free';
  /** Whether the platform supports image attachment upload (capabilities.commentAttachments); passed through to the reply editor to enable paste upload. */
  attachmentsEnabled?: boolean;
  /** Content read-only (decline / archived PR that can't be participated in): hide the inline comment reply / edit / delete actions. */
  readOnly?: boolean;
}) {
  return (
    <div className="comment-zone-inner">
      {comments.map((c, i) => (
        <div
          key={c.remoteId}
          className={`comment-zone-item${i > 0 ? ' comment-zone-item-divider' : ''}`}
        >
          <CommentNode
            comment={c}
            connectionId={connectionId}
            depth={0}
            attachmentBase={attachmentBase}
            prLocalId={prLocalId}
            prWebUrl={prWebUrl}
            hardBreaks={hardBreaks}
            reactionsMode={reactionsMode}
            attachmentsEnabled={attachmentsEnabled}
            readOnly={readOnly}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Rewrite `attachment:HASH` style URLs in Bitbucket comment markdown into clickable Bitbucket links.
 * Returns null = not an attachment URL, caller handles it as-is.
 */
function resolveAttachmentUrl(href: string, base: string | null): string | null {
  if (!base || !href.startsWith('attachment:')) return null;
  const hash = href.slice('attachment:'.length).trim();
  if (!hash) return null;
  return `${base}/${encodeURIComponent(hash)}`;
}

/**
 * react-markdown components override: a/img detect the attachment: protocol and rewrite to a Bitbucket URL.
 * Image attachments require Bitbucket session auth so the renderer can't fetch them; they fall back to a
 * clickable link (📎 alt text). Clicking goes through setWindowOpenHandler → shell.openExternal to open in
 * the system browser, where the user's Bitbucket login session can load them normally.
 */
function makeCommentMarkdownComponents(
  attachmentBase: string | null,
  prLocalId: string,
  prWebUrl: string,
): Parameters<typeof ReactMarkdown>[0]['components'] {
  const BitbucketImage = makeBitbucketImageFor(prLocalId, prWebUrl);
  return {
    a: ({ href, children, ...rest }) => {
      const resolved = href ? resolveAttachmentUrl(href, attachmentBase) : null;
      const finalHref = resolved ?? href;
      return (
        <a {...rest} href={finalHref} target="_blank" rel="noreferrer">
          {resolved ? '📎 ' : null}
          {children}
        </a>
      );
    },
    img: ({ src, alt }) => {
      if (typeof src !== 'string' || !src) return null;
      // Pass src through to IPC as-is — the main-side adapter understands the Bitbucket `attachment:HASH`
      // protocol + absolute/relative URLs, so the renderer needn't resolve up front. An external public URL
      // is treated as cross-host on the main side and returns null; BitbucketImage falls back internally to a native <img>
      return <BitbucketImage src={src} alt={alt} />;
    },
  };
}

/**
 * Recursively render a single comment + its reply subtree. comment.replies is arbitrarily deep; recurse all
 * the way down. Each level down adds a step of indent + a left vertical line (indent amount / border color
 * aligned with the comments tab's .pr-comments-replies, see comment-zone.scss).
 */
/** Nested indent maxes out at 5 levels; deeper replies beyond this level are **flattened** (comment-zone-reply-flat:
 *  drop step / border / left padding), laid out on the level-5 indent stacked vertically, to avoid infinite nesting sliding ever rightward. */
const MAX_REPLY_INDENT_DEPTH = 5;

function CommentNode({
  comment,
  connectionId,
  depth,
  attachmentBase,
  prLocalId,
  prWebUrl,
  hardBreaks,
  reactionsMode,
  attachmentsEnabled = false,
  readOnly = false,
}: {
  comment: PrComment;
  connectionId: string;
  depth: number;
  attachmentBase: string | null;
  prLocalId: string;
  prWebUrl: string;
  hardBreaks: boolean;
  reactionsMode?: 'fixed' | 'free';
  attachmentsEnabled?: boolean;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const components = useMemo(
    () => makeCommentMarkdownComponents(attachmentBase, prLocalId, prWebUrl),
    [attachmentBase, prLocalId, prWebUrl],
  );
  // Reaction state + toggle (shares useReactions with the comments / activity tab's CommentItem; the hook is
  // called unconditionally, output only rendered when reactionsMode is present). kind inferred from comment.anchor as 'inline'.
  const { reactions, busy: reactionBusy, toggle: toggleReaction } = useReactions(
    prLocalId,
    comment,
    readOnly,
  );
  // Reply / edit / delete interaction state machine (shared with the comments/activity tab's CommentItem, see shared/useCommentThread)
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
  } = useCommentThread(prLocalId, comment);

  // body wraps only author + content + reply button / editor; replies live outside as siblings —
  // so hovering inner replies doesn't bubble up to trigger the outer :hover and reveal all ancestor reply buttons at once
  const inner = (
    <>
      <div className="comment-zone-item-body">
        <CommentAuthorRow
          displayName={comment.author.displayName}
          slug={comment.author.slug ?? comment.author.name}
          avatarUrl={comment.author.avatarUrl}
          connectionId={connectionId}
          at={comment.createdAt}
        />
        {editOpen && typeof comment.version === 'number' ? (
          <CommentEditEditor
            prLocalId={prLocalId}
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
            components={components}
            className="comment-zone-body markdown"
          />
        )}
        {/* Reply / edit / delete buttons: hidden by default, shown on hover of comment-zone-item-body (CSS).
            Edit mode hides all buttons (to avoid duplicating the editor's bottom button group); read-only (decline / can't participate) hides the whole group. */}
        {!readOnly && !replyOpen && !editOpen && (
          <div className="comment-zone-foot">
            <button
              type="button"
              className="comment-zone-reply-btn"
              onClick={() => setReplyOpen(true)}
            >
              {t('commentsPanel.reply')}
            </button>
            {canEdit && (
              <button
                type="button"
                className="comment-zone-edit-btn"
                onClick={() => setEditOpen(true)}
                title={t('commentsPanel.editTitle')}
              >
                {t('common.edit')}
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                className="comment-zone-delete-btn"
                onClick={() => setConfirmDelete(true)}
                disabled={deleting}
                title={t('commentsPanel.deleteTitle')}
              >
                {deleting ? t('commentsPanel.deleting') : t('common.delete')}
              </button>
            )}
            {/* The "add reaction" button goes after the action buttons (consistent with the comments tab); the whole foot group is already hidden in reply / edit mode. */}
            {reactionsMode && (
              <ReactionAddButton
                reactions={reactions}
                busy={reactionBusy}
                mode={reactionsMode}
                onToggle={toggleReaction}
              />
            )}
          </div>
        )}
        {replyOpen && (
          <CommentReplyEditor
            prLocalId={prLocalId}
            // Reply target abstraction (threadId): GitLab=discussion id (required for reply); Bitbucket empty / GitHub=remoteId → fall back to remoteId.
            parentCommentId={comment.threadId ?? comment.remoteId}
            attachmentsEnabled={attachmentsEnabled}
            onCancel={() => setReplyOpen(false)}
            onPosted={() => setReplyOpen(false)}
          />
        )}
        {/* Existing reactions: on their own line, rendered below the action buttons (hidden in edit mode). Under readOnly, display only, not toggleable. */}
        {reactionsMode && !editOpen && (
          <ReactionChips
            reactions={reactions}
            busy={reactionBusy}
            readOnly={readOnly}
            onToggle={toggleReaction}
          />
        )}
        {deleteError && (
          <div className="comment-zone-delete-error" role="alert">
            {t('commentsPanel.deleteFailed', { msg: deleteError })}
            <button
              type="button"
              className="comment-zone-delete-error-dismiss"
              onClick={() => setDeleteError(null)}
              aria-label={t('commentsPanel.dismissErrorAria')}
              title={t('commentsPanel.dismissErrorTitle')}
            >
              ✕
            </button>
          </div>
        )}
      </div>
      {comment.replies.map((r) => (
        <CommentNode
          key={r.remoteId}
          comment={r}
          connectionId={connectionId}
          depth={depth + 1}
          attachmentBase={attachmentBase}
          prLocalId={prLocalId}
          prWebUrl={prWebUrl}
          hardBreaks={hardBreaks}
          reactionsMode={reactionsMode}
          attachmentsEnabled={attachmentsEnabled}
          readOnly={readOnly}
        />
      ))}
      {confirmDelete && (
        <ConfirmModal
          title={t('commentsPanel.deleteConfirmTitle')}
          message={t('commentsPanel.deleteConfirmMessage')}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          danger
          onConfirm={() => void handleDelete()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
  if (depth === 0) return inner;
  // Past MAX_REPLY_INDENT_DEPTH levels, **flatten**: drop the step indent and left vertical line, laying deeper
  // replies out on the max level (consistent with the comments tab design). Key: must drop both padding-left AND
  // border — dropping only the step while keeping each level's padding/border still accumulates and shifts right
  // (the root cause of the earlier "still indented" bug).
  const flat = depth > MAX_REPLY_INDENT_DEPTH;
  return (
    <div className={`comment-zone-reply${flat ? ' comment-zone-reply-flat' : ''}`}>{inner}</div>
  );
}

function CommentAuthorRow({
  displayName,
  slug,
  avatarUrl,
  connectionId,
  at,
}: {
  displayName: string;
  slug: string;
  avatarUrl?: string;
  connectionId: string;
  at: string;
}) {
  return (
    <div className="comment-zone-head">
      <Avatar
        connectionId={connectionId}
        slug={slug}
        displayName={displayName}
        avatarUrl={avatarUrl}
        size={18}
      />
      <strong>{displayName}</strong>
      <span className="muted">{formatTimestamp(at)}</span>
    </div>
  );
}

/** Combine multiple same-line comments into markdown hover text (including nested replies) */
export function renderHoverMd(comments: PrComment[]): string {
  return comments
    .map((c) => {
      const head = `**${c.author.displayName}** · ${formatTimestamp(c.createdAt, { full: true })}`;
      const body = c.body.length > 600 ? c.body.slice(0, 600) + '…' : c.body;
      const replies = c.replies
        .map(
          (r) =>
            `> **${r.author.displayName}**: ${r.body.length > 200 ? r.body.slice(0, 200) + '…' : r.body}`,
        )
        .join('\n');
      return `${head}\n\n${body}${replies ? '\n\n' + replies : ''}`;
    })
    .join('\n\n---\n\n');
}
