import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { Reviewer, ReviewerStatus } from '@meebox/shared';
import { Avatar } from '../../common';
import { REVIEWER_STATUS_META, ReviewerBadgeGlyph } from './reviewer-status';

const STACK_AVATAR_SIZE = 32;

/** A single avatar + top-right decision badge (approved green check / needsWork amber exclamation; no badge when pending review). Shared by stack items and the "me" item. */
function StackAvatar({ r, connectionId }: { r: Reviewer; connectionId: string }) {
  return (
    <>
      <Avatar
        connectionId={connectionId}
        slug={r.slug ?? r.name}
        displayName={r.displayName}
        avatarUrl={r.avatarUrl}
        size={STACK_AVATAR_SIZE}
      />
      {(r.status === 'approved' || r.status === 'needsWork') && (
        <span className={`reviewer-stack-badge reviewer-stack-badge-${r.status}`} aria-hidden="true">
          <ReviewerBadgeGlyph status={r.status} size={14} />
        </span>
      )}
    </>
  );
}
// Total ≤ MAX_VISIBLE shows all; beyond that shows (MAX_VISIBLE-1) avatars + one "+n" overflow item
const MAX_VISIBLE = 4;
// Sort priority: needsWork (pending, most in need of attention) > approved > pending review
const STATUS_RANK: Record<ReviewerStatus, number> = { needsWork: 0, approved: 1, unapproved: 2 };

/**
 * Reviewer avatar stack at the top-right of the PR header (Bitbucket style, slightly overlapping):
 * - Filters out the current user; sorted by priority needsWork > approved > pending review, same-rank by stable displayName sort
 * - approved gets a top-right green check, needsWork a top-right amber exclamation badge (no badge for pending review)
 * - Shows at most 4; beyond that shows 3 + "+n", clicking "+n" drops down the remaining reviewers (avatar + name + decision chip)
 * - Directly shown avatars reveal the name on hover (via Avatar's built-in title)
 * - When `self` (the current user's "my review") is non-null, shows its avatar + current review badge separated on the stack's right
 * Not rendered when the stack has no others and no self.
 */
export function ReviewerStack({
  reviewers,
  connectionId,
  currentUserName,
  self,
}: {
  reviewers: Reviewer[];
  connectionId: string;
  currentUserName?: string | null;
  /** The current user's "my review": avatar + current review badge, shown separated to the right of the others' avatar stack. */
  self?: Reviewer | null;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  // Dropdown positioning + outside-click close + recompute on window changes (same setup as DiffScopeSelect, fixed + portal to avoid clipping)
  useEffect(() => {
    if (!open) return;
    const compute = (): void => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    };
    compute();
    const onDoc = (e: MouseEvent): void => {
      const tgt = e.target as Node;
      if (triggerRef.current?.contains(tgt) || menuRef.current?.contains(tgt)) return;
      setOpen(false);
    };
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    document.addEventListener('mousedown', onDoc);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [open]);

  const sorted = reviewers
    .filter((r) => !currentUserName || r.name !== currentUserName)
    .slice()
    .sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        a.displayName.localeCompare(b.displayName) ||
        a.name.localeCompare(b.name),
    );

  if (sorted.length === 0 && !self) return null;

  const overflow = sorted.length > MAX_VISIBLE;
  const visible = overflow ? sorted.slice(0, MAX_VISIBLE - 1) : sorted;
  const hidden = overflow ? sorted.slice(MAX_VISIBLE - 1) : [];
  // Under overlap, let the left avatar sit over the right (decreasing z), so each one's top-right badge isn't occluded by the adjacent avatar
  const topZ = sorted.length + 1;

  return (
    <div className="reviewer-stack">
      {visible.map((r, i) => (
        <span
          key={r.name}
          className="reviewer-stack-item"
          style={{ zIndex: topZ - i }}
          title={r.displayName}
        >
          <StackAvatar r={r} connectionId={connectionId} />
        </span>
      ))}
      {overflow && (
        <button
          ref={triggerRef}
          type="button"
          className={`reviewer-stack-more${open ? ' open' : ''}`}
          style={{ zIndex: 1 }}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="true"
          aria-expanded={open}
          aria-label={t('mainPane.moreReviewers', { n: hidden.length })}
        >
          +{hidden.length}
        </button>
      )}
      {/* "My review": separated from the others' avatar stack (thin divider line + spacing on the left), shows the current user's avatar + current review badge. */}
      {self && (
        <span
          className="reviewer-stack-item reviewer-stack-self"
          title={t('mainPane.myReviewTitle', { name: self.displayName })}
        >
          <StackAvatar r={self} connectionId={connectionId} />
        </span>
      )}
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="reviewer-stack-menu"
            style={{ position: 'fixed', top: pos.top, right: pos.right }}
            role="menu"
          >
            {hidden.map((r) => {
              const meta = REVIEWER_STATUS_META[r.status];
              return (
                <div key={r.name} className="reviewer-stack-menu-item" role="menuitem">
                  <Avatar
                    connectionId={connectionId}
                    slug={r.slug ?? r.name}
                    displayName={r.displayName}
                    avatarUrl={r.avatarUrl}
                    size={22}
                  />
                  <span className="reviewer-stack-menu-name">{r.displayName}</span>
                  <span className={`pr-activity-chip pr-activity-chip-${meta.chipKind}`}>
                    {t(meta.labelKey)}
                  </span>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
