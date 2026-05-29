import type { StoredPullRequest } from '@pr-pilot/shared';

interface PrItemProps {
  pr: StoredPullRequest;
  selected: boolean;
  onClick: () => void;
}

export function PrItem({ pr, selected, onClick }: PrItemProps) {
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
      </div>
    </div>
  );
}
