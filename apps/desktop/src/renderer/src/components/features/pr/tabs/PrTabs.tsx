import { useTranslation } from 'react-i18next';
import { ChatIcon, PersonIcon, WhitespaceIcon } from '../../../common';

export type PrTab = 'diff' | 'activity' | 'drafts' | 'commits' | 'info';

/**
 * PR detail tab bar: diff / comments / drafts / commits / info (with count badges); when on the diff tab, the right side
 * carries a whitespace-visibility / blame / side-by-side-inline toggle toolbar.
 */
export function PrTabs({
  tab,
  onTab,
  commentCount,
  commitCount,
  totalDraftCount,
  publishableCount,
  activityTimeline,
  readOnly = false,
  onNewComment,
  showWhitespace,
  onToggleWhitespace,
  showBlame,
  onToggleBlame,
  renderSideBySide,
  onSetRenderSideBySide,
}: {
  tab: PrTab;
  onTab: (tab: PrTab) => void;
  commentCount: number | null;
  commitCount: number | null;
  totalDraftCount: number;
  publishableCount: number;
  /** Whether the platform provides an activity timeline (see capabilities.activityTimeline); otherwise this tab's title degrades to "Comments" */
  activityTimeline: boolean;
  /** Content is read-only (declined / non-participable archived PR): hides the "new comment" entry point. */
  readOnly?: boolean;
  /** The "Comment" button on the right of the activity tab: creates a comment not anchored to a file */
  onNewComment: () => void;
  showWhitespace: boolean;
  onToggleWhitespace: () => void;
  showBlame: boolean;
  onToggleBlame: () => void;
  renderSideBySide: boolean;
  onSetRenderSideBySide: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <nav className="pr-tabs" role="tablist">
      <button
        type="button"
        className={`pr-tab ${tab === 'diff' ? 'active' : ''}`}
        onClick={() => onTab('diff')}
        role="tab"
        aria-selected={tab === 'diff'}
      >
        {t('mainPane.tabDiff')}
      </button>
      {/* The activity timeline (comments + commits + review decisions) comes before commits: during review, discussion
          weighs more than a plain commit list. The badge still uses the comment count — discussion volume is the most
          actionable indicator, and commits have their own separate tab count. */}
      <button
        type="button"
        className={`pr-tab ${tab === 'activity' ? 'active' : ''}`}
        onClick={() => onTab('activity')}
        role="tab"
        aria-selected={tab === 'activity'}
      >
        {t(activityTimeline ? 'mainPane.tabActivity' : 'mainPane.tabComments')}
        <TabCountBadge
          count={commentCount}
          ariaLabel={(n) => t('mainPane.commentCountAria', { count: n })}
        />
      </button>
      {/* Drafts tab: visibility condition uses the total count — even after all are posted you can still enter the tab
          to view posted/rejected history; only PRs that never created a draft hide the tab entirely, avoiding a redundant entry point */}
      {totalDraftCount > 0 && (
        <button
          type="button"
          className={`pr-tab ${tab === 'drafts' ? 'active' : ''}`}
          onClick={() => onTab('drafts')}
          role="tab"
          aria-selected={tab === 'drafts'}
        >
          {t('mainPane.tabDrafts')}
          {publishableCount > 0 && (
            <span
              className="pr-tab-badge pr-tab-badge-warning"
              aria-label={t('mainPane.draftBadgeAria', { count: publishableCount })}
              title={t('mainPane.draftBadgeTitle')}
            >
              {publishableCount}
            </span>
          )}
        </button>
      )}
      <button
        type="button"
        className={`pr-tab ${tab === 'commits' ? 'active' : ''}`}
        onClick={() => onTab('commits')}
        role="tab"
        aria-selected={tab === 'commits'}
      >
        {t('mainPane.tabCommits')}
        <TabCountBadge
          count={commitCount}
          ariaLabel={(n) => t('mainPane.commitCountAria', { count: n })}
        />
      </button>
      <button
        type="button"
        className={`pr-tab ${tab === 'info' ? 'active' : ''}`}
        onClick={() => onTab('info')}
        role="tab"
        aria-selected={tab === 'info'}
      >
        {t('mainPane.tabInfo')}
      </button>
      {tab === 'activity' && !readOnly && (
        <div className="pr-tabs-right">
          <button type="button" className="pr-tab-action-btn" onClick={onNewComment}>
            <ChatIcon /> {t('mainPane.newComment')}
          </button>
        </div>
      )}
      {tab === 'diff' && (
        <div className="pr-tabs-right">
          <button
            type="button"
            className={`blame-toggle ${showWhitespace ? 'active' : ''}`}
            onClick={onToggleWhitespace}
            title={showWhitespace ? t('mainPane.hideWhitespace') : t('mainPane.showWhitespace')}
            aria-pressed={showWhitespace}
          >
            <WhitespaceIcon /> {t('mainPane.whitespace')}
          </button>
          <button
            type="button"
            className={`blame-toggle ${showBlame ? 'active' : ''}`}
            onClick={onToggleBlame}
            title={showBlame ? t('mainPane.hideBlame') : t('mainPane.showBlame')}
            aria-pressed={showBlame}
          >
            <PersonIcon /> {t('mainPane.blame')}
          </button>
          <div className="diff-mode-toggle" role="tablist" aria-label={t('mainPane.diffModeAria')}>
            <button
              type="button"
              className={renderSideBySide ? 'active' : ''}
              onClick={() => onSetRenderSideBySide(true)}
              role="tab"
              aria-selected={renderSideBySide}
            >
              {t('mainPane.sideBySide')}
            </button>
            <button
              type="button"
              className={!renderSideBySide ? 'active' : ''}
              onClick={() => onSetRenderSideBySide(false)}
              role="tab"
              aria-selected={!renderSideBySide}
            >
              {t('mainPane.unified')}
            </button>
          </div>
        </div>
      )}
    </nav>
  );
}

/**
 * Tab count badge. Counts load asynchronously (comments / commits):
 * - `null` (loading): renders a fixed-width placeholder chip, reserving badge width to eliminate the tab's horizontal spring-jitter when the count arrives;
 * - `> 0`: the real numeric badge;
 * - `0`: not rendered (no badge).
 */
function TabCountBadge({
  count,
  ariaLabel,
}: {
  count: number | null;
  ariaLabel: (n: number) => string;
}) {
  if (count === null) {
    return <span className="pr-tab-badge pr-tab-badge-loading" aria-hidden="true" />;
  }
  if (count > 0) {
    return (
      <span className="pr-tab-badge" aria-label={ariaLabel(count)}>
        {count}
      </span>
    );
  }
  return null;
}
