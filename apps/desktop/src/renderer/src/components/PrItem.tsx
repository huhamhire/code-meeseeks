import type { StoredPullRequest } from '@pr-pilot/shared';
import { Avatar } from './Avatar';

/** 作者行前缀：头肩剪影，跟 meta gutter 左对齐 */
function PersonIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="5" r="2.5" />
      <path d="M3 13c0-2.5 2.2-4 5-4s5 1.5 5 4" />
    </svg>
  );
}

/** 分支行前缀：git pull-request 字形，暗示源→目标 */
function PullRequestIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="4" cy="4" r="1.6" />
      <circle cx="4" cy="12" r="1.6" />
      <line x1="4" y1="5.6" x2="4" y2="10.4" />
      <circle cx="12" cy="12" r="1.6" />
      <path d="M12 10.4 V7 a3 3 0 0 0 -3 -3 H6.5" />
      <path d="M8 2 L6 4 L8 6" />
    </svg>
  );
}

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
          <div className="pr-item-meta-row">
            <span className="pr-item-meta-author">
              <PersonIcon />
              {pr.author.displayName}
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
          <div className="pr-item-meta-row">
            <span className="pr-item-meta-branch">
              <PullRequestIcon />
              {pr.sourceRef.displayId} → {pr.targetRef.displayId}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
