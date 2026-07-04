import type { ReviewerStatus } from '@meebox/shared';
import { AlertGlyphIcon, ApproveIcon, CheckGlyphIcon, NeedsWorkIcon } from '../../common';

/**
 * Display metadata and icons for reviewer status, shared by the detail page reviewer list (PrInfoView),
 * the PR header avatar stack (ReviewerStack), etc.: status → decision chip kind (reuses activity timeline chip colors) + label key (reuses prStatus).
 */
export const REVIEWER_STATUS_META: Record<ReviewerStatus, { chipKind: string; labelKey: string }> =
  {
    approved: { chipKind: 'approved', labelKey: 'prStatus.approved' },
    needsWork: { chipKind: 'needsWork', labelKey: 'prStatus.needsWork' },
    unapproved: { chipKind: 'unapproved', labelKey: 'prStatus.pending' },
  };

/** Reviewer status icon: approve green check / needs-work amber exclamation / pending review neutral hollow dot. */
export function ReviewerStatusIcon({
  status,
  size = 16,
}: {
  status: ReviewerStatus;
  size?: number;
}) {
  if (status === 'approved') return <ApproveIcon size={size} />;
  if (status === 'needsWork') return <NeedsWorkIcon size={size} />;
  return <span className="reviewer-pending-dot" />;
}

/**
 * Pure symbol glyph for the avatar stack badge (no outer ring): displayed reversed on a solid colored background, keeping only the inner check / exclamation.
 * Only approved / needsWork have one; others return null (pending review has no badge).
 */
export function ReviewerBadgeGlyph({ status, size = 16 }: { status: ReviewerStatus; size?: number }) {
  if (status === 'approved') return <CheckGlyphIcon size={size} />;
  if (status === 'needsWork') return <AlertGlyphIcon size={size} />;
  return null;
}
