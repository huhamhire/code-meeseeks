import { useTranslation } from 'react-i18next';
import type {
  LocalPrStatus,
  PlatformCapabilities,
  Reviewer,
  ReviewerStatus,
  StoredPullRequest,
} from '@meebox/shared';
import { ApproveIcon, GlobeIcon, NeedsWorkIcon, PullRequestIcon } from '../../common';
import { ReviewerStack } from './ReviewerStack';

/**
 * PR detail header: title / meta + action area (open in browser · publish comments N · merge · approve / needs work).
 * Approval buttons degrade by platform capability bits; you cannot approve your own PR (disabled + reason).
 */
export function PrHeader({
  pr,
  capabilities,
  currentUserName,
  merging,
  onMerge,
  onSetStatus,
  hideLifecycle = false,
  readOnly = false,
  publishableCount,
  onPublish,
}: {
  pr: StoredPullRequest;
  capabilities?: PlatformCapabilities;
  currentUserName?: string | null;
  merging: boolean;
  onMerge: () => void;
  onSetStatus: (status: LocalPrStatus) => void;
  /** Hide PR lifecycle actions (merge + review decision): always set for the closed scope. */
  hideLifecycle?: boolean;
  /** Content read-only (declined / cannot participate): hides the "publish comments (N)" entry. */
  readOnly?: boolean;
  publishableCount: number;
  onPublish: () => void;
}) {
  const { t } = useTranslation();
  // Capability-bit degradation: reviewStatuses drives approval-button visibility; no degradation when capabilities is undefined (old data / no connection).
  const reviewAllowed = (s: ReviewerStatus): boolean =>
    !capabilities || capabilities.reviewStatuses.includes(s);
  const isOwnPr = !!currentUserName && pr.author.name === currentUserName;
  const ownPrReason = isOwnPr ? t('mainPane.ownPrReason') : undefined;
  // "My review": take the current user's reviewer entry (avatar); the badge status uses the local decision localStatus
  // (approval buttons update instantly, more responsive than the remote reviewer.status). Your own PR is not reviewable → not shown.
  const selfReviewer =
    !isOwnPr && currentUserName ? pr.reviewers.find((r) => r.name === currentUserName) : undefined;
  const selfReviewStatus: ReviewerStatus =
    pr.localStatus === 'approved'
      ? 'approved'
      : pr.localStatus === 'needs_work'
        ? 'needsWork'
        : 'unapproved';
  const self: Reviewer | undefined = selfReviewer
    ? { ...selfReviewer, status: selfReviewStatus }
    : undefined;

  return (
    <header className="pr-header">
      <div className="pr-header-top">
        <div className="pr-header-main">
          <h2 className="pr-header-title">
            <span className="muted">#{pr.remoteId}</span> {pr.title}
          </h2>
          <div className="pr-header-meta">
            {pr.hasConflict && (
              <>
                <span className="conflict-tag" title={t('mainPane.conflictTitle')}>
                  ⚠️ {t('mainPane.conflict')}
                </span>
                <span> · </span>
              </>
            )}
            <strong>
              {pr.repo.projectKey}/{pr.repo.repoSlug}
            </strong>
            <span> · {pr.author.displayName}</span>
            <span>
              {' '}
              · {pr.sourceRef.displayId} → {pr.targetRef.displayId}
            </span>
            <span> · </span>
            <span className={`status-tag status-${pr.localStatus}`}>
              {t(`prStatus.${pr.localStatus === 'needs_work' ? 'needsWork' : pr.localStatus}`)}
            </span>
          </div>
        </div>
        {/* reviewer avatar stack: right of the title + meta band, above the button row, vertically centered */}
        <ReviewerStack
          reviewers={pr.reviewers}
          connectionId={pr.connectionId}
          currentUserName={currentUserName}
          self={self}
        />
      </div>
      <div className="pr-header-actions">
        <a
          className="btn btn-primary btn-sm pr-header-open-browser"
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          title={t('mainPane.openInBrowserTitle')}
        >
          <GlobeIcon /> {t('mainPane.openInBrowser')}
        </a>
        {/* approve / needs work: current status = highlighted; clicking an already-highlighted one falls back to pending (revokes the remote mark).
            "Publish comments (N)" sits to the left of the decision buttons — reviewing is two steps: post comments first (left), then make the decision (right). */}
        <div className="pr-header-actions-right">
          {/* "Publish comments" renders only when there are drafts pending publish: at N=0 the whole button hides, reducing header visual noise. */}
          {!readOnly && publishableCount > 0 && (
            <button
              type="button"
              className="btn btn-sm pr-header-publish"
              onClick={onPublish}
              title={t('mainPane.publishCommentsTitle', { n: publishableCount })}
            >
              {t('mainPane.publishComments', { n: publishableCount })}
            </button>
          )}
          {/* Merge button: appears only when the server deems it mergeable (canMerge). Clicking merges directly (no confirmation). Hidden when read-only. */}
          {!hideLifecycle && pr.mergeStatus?.canMerge && (
            <button
              type="button"
              className="btn btn-sm pr-header-merge"
              onClick={onMerge}
              disabled={merging}
              aria-busy={merging}
              title={t('mainPane.mergeTitle')}
            >
              <PullRequestIcon size={14} /> {merging ? t('mainPane.merging') : t('mainPane.merge')}
            </button>
          )}
          {!hideLifecycle && reviewAllowed('approved') && (
            <button
              className={`btn btn-sm review-action review-action-approve ${pr.localStatus === 'approved' ? 'active' : ''}`}
              type="button"
              disabled={isOwnPr}
              onClick={() => onSetStatus(pr.localStatus === 'approved' ? 'pending' : 'approved')}
              title={
                ownPrReason ??
                (pr.localStatus === 'approved'
                  ? t('mainPane.undoApprove')
                  : t('mainPane.markApprove'))
              }
              aria-pressed={pr.localStatus === 'approved'}
            >
              <ApproveIcon /> {t('mainPane.approve')}
            </button>
          )}
          {!hideLifecycle && reviewAllowed('needsWork') && (
            <button
              className={`btn btn-sm review-action review-action-needs-work ${pr.localStatus === 'needs_work' ? 'active' : ''}`}
              type="button"
              disabled={isOwnPr}
              onClick={() =>
                onSetStatus(pr.localStatus === 'needs_work' ? 'pending' : 'needs_work')
              }
              title={
                ownPrReason ??
                (pr.localStatus === 'needs_work'
                  ? t('mainPane.undoNeedsWork')
                  : t('mainPane.markNeedsWork'))
              }
              aria-pressed={pr.localStatus === 'needs_work'}
            >
              <NeedsWorkIcon /> {t('mainPane.needsWork')}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
