import type { StoredPullRequest } from '@pr-pilot/shared';
import { Avatar } from './Avatar';

interface PrItemProps {
  pr: StoredPullRequest;
  selected: boolean;
  onClick: () => void;
}

export function PrItem({ pr, selected, onClick }: PrItemProps) {
  const approvedCount = pr.reviewers.filter((r) => r.status === 'approved').length;
  const needsWorkCount = pr.reviewers.filter((r) => r.status === 'needsWork').length;
  return (
    <div
      className={`pr-item ${selected ? 'selected' : ''} pr-item-status-${pr.localStatus}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <Avatar
        connectionId={pr.connectionId}
        slug={pr.author.slug ?? pr.author.name}
        displayName={pr.author.displayName}
        size={40}
      />
      <div className="pr-item-body">
        <div className="pr-item-title">
          {pr.hasConflict && (
            <span className="conflict-warn" title="存在合并冲突" aria-label="conflict">
              ⚠️
            </span>
          )}
          <span className="pr-item-id">#{pr.remoteId}</span> {pr.title}
        </div>
        <div className="pr-item-meta">
          <span>{pr.author.displayName}</span>
          <span>·</span>
          <span>
            {pr.sourceRef.displayId} → {pr.targetRef.displayId}
          </span>
          {(approvedCount > 0 || needsWorkCount > 0) && (
            <span className="pr-item-review-chips">
              {approvedCount > 0 && (
                <span
                  className="review-chip review-chip-approved"
                  title={`${String(approvedCount)} 位 reviewer 已 approve`}
                >
                  ✓ {approvedCount}
                </span>
              )}
              {needsWorkCount > 0 && (
                <span
                  className="review-chip review-chip-needs-work"
                  title={`${String(needsWorkCount)} 位 reviewer 标记 needs work`}
                >
                  ✗ {needsWorkCount}
                </span>
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
