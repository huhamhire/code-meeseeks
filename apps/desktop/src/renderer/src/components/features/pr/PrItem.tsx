import { useTranslation } from 'react-i18next';
import type { AgentRecommendationVerdict, StoredPullRequest } from '@meebox/shared';
import { Avatar, PersonIcon, PullRequestIcon, StarIcon } from '../../common';

/** Review recommendation verdict → reuse chatPane.agent.* strings (no extra i18n). */
const VERDICT_TITLE: Record<string, string> = {
  approve: 'chatPane.agent.verdictApprove',
  needs_work: 'chatPane.agent.verdictNeedsWork',
  manual_review: 'chatPane.agent.verdictManualReview',
};

interface PrItemProps {
  pr: StoredPullRequest;
  selected: boolean;
  onClick: () => void;
  /** Review recommendation leaning (ledger written by manual / AutoPilot review, treated alike); absent → no ★ badge. */
  reviewVerdict?: AgentRecommendationVerdict | null;
  /** This PR currently has a running agent task (tool run running / queued): shows a blue "executing" animated indicator in the same spot. */
  executing?: boolean;
}

export function PrItem({ pr, selected, onClick, reviewVerdict, executing }: PrItemProps) {
  const { t } = useTranslation();
  const approvedCount = pr.reviewers.filter((r) => r.status === 'approved').length;
  const needsWorkCount = pr.reviewers.filter((r) => r.status === 'needsWork').length;
  // "@me / replied to me" unread count: when >0, the unread dot left of the title is replaced by a neutral number chip (capped at 10 → shows "10+");
  // unread from only new arrivals / new commits (count 0) still shows the dot. The two are mutually exclusive in that slot.
  const mentionCount = pr.unreadMentionCount ?? 0;
  // Server deems it directly mergeable: marked in the list with a branch-merge icon chip (pure status, no number).
  // Optional-chaining fallback: meta.json persisted before the upgrade may not yet have mergeStatus; the next poll fills it in
  const canMerge = pr.mergeStatus?.canMerge ?? false;
  return (
    <div
      className={`pr-item ${selected ? 'selected' : ''} pr-item-status-${pr.localStatus} ${pr.unread ? 'pr-item-unread' : ''}`}
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
        avatarUrl={pr.author.avatarUrl}
        size={40}
      />
      <div className="pr-item-body">
        <div className="pr-item-title">
          {mentionCount > 0 ? (
            <span
              className="pr-item-unread-count"
              title={t('prItem.unreadMentionCount', { count: mentionCount })}
              aria-label={t('prItem.unreadMentionCount', { count: mentionCount })}
            >
              {mentionCount > 9 ? '10+' : mentionCount}
            </span>
          ) : (
            pr.unread && (
              <span className="pr-item-unread-dot" title={t('prItem.unread')} aria-label="unread" />
            )
          )}
          {pr.hasConflict && (
            <span className="conflict-warn" title={t('prItem.hasConflict')} aria-label="conflict">
              ⚠️
            </span>
          )}
          <span className="pr-item-id">#{pr.remoteId}</span> {pr.title}
        </div>
        <div className="pr-item-meta">
          <div className="pr-item-meta-row">
            <span className="pr-item-meta-author">
              <PersonIcon />
              <span className="pr-item-meta-text">{pr.author.displayName}</span>
            </span>
            {(approvedCount > 0 ||
              needsWorkCount > 0 ||
              canMerge ||
              reviewVerdict ||
              executing) && (
              <span className="pr-item-review-chips">
                {/* Executing takes priority in the slot (same ★ position): reuses the run card's .spinner (blue rotating ring, centrally symmetric),
                    a bare icon with no chip frame, indicating this PR has a running agent task. */}
                {executing && (
                  <span
                    className="spinner pr-item-spinner"
                    role="img"
                    title={t('prItem.executing')}
                    aria-label="executing"
                  />
                )}
                {reviewVerdict && (
                  <span
                    className={`review-chip verdict-chip verdict-chip-${reviewVerdict}`}
                    title={t(VERDICT_TITLE[reviewVerdict])}
                    aria-label={`review ${reviewVerdict}`}
                  >
                    <StarIcon />
                  </span>
                )}
                {canMerge && (
                  <span
                    className="review-chip review-chip-mergeable"
                    title={t('prItem.mergeable')}
                    aria-label="mergeable"
                  >
                    <PullRequestIcon />
                  </span>
                )}
                {approvedCount > 0 && (
                  <span
                    className="review-chip review-chip-approved"
                    title={t('prItem.approvedCount', { count: approvedCount })}
                  >
                    ✓ {approvedCount}
                  </span>
                )}
                {needsWorkCount > 0 && (
                  <span
                    className="review-chip review-chip-needs-work"
                    title={t('prItem.needsWorkCount', { count: needsWorkCount })}
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
              <span className="pr-item-meta-text">
                {pr.sourceRef.displayId} → {pr.targetRef.displayId}
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
