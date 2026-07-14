import type { PrCommentAnchor, ReviewDraftAnchor } from '@meebox/shared';

/**
 * Snapshot a parent comment's anchor into a ReviewDraftAnchor for a reply-draft. Only inline/line comments yield an
 * anchor (used to position the reply-draft's diff zone at the parent's line); a summary comment or a file-level comment
 * (no line) yields undefined, so its reply-draft renders only under the parent / in the drafts panel, not as a diff zone.
 */
export function toReplyDraftAnchor(
  anchor?: PrCommentAnchor | null,
): ReviewDraftAnchor | undefined {
  if (!anchor || anchor.line == null) return undefined;
  return { path: anchor.path, startLine: anchor.line, endLine: anchor.line, side: anchor.side };
}
