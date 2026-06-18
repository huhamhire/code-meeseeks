import { useTranslation } from 'react-i18next';
import { PersonIcon, WhitespaceIcon } from '../../../common/icons';

export type PrTab = 'diff' | 'comments' | 'drafts' | 'commits' | 'info';

/**
 * PR 详情 tab 栏：diff / 评论 / 草稿 / 提交 / 信息（带计数徽标），diff tab 时右侧附带
 * 空白可视 / blame / 并排-内联 切换工具条。
 */
export function PrTabs({
  tab,
  onTab,
  commentCount,
  commitCount,
  totalDraftCount,
  publishableCount,
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
      {/* comments 在 commits 前：评审决断时评论的权重大于 commit 时间线 */}
      <button
        type="button"
        className={`pr-tab ${tab === 'comments' ? 'active' : ''}`}
        onClick={() => onTab('comments')}
        role="tab"
        aria-selected={tab === 'comments'}
      >
        {t('mainPane.tabComments')}
        {commentCount !== null && commentCount > 0 && (
          <span
            className="pr-tab-badge"
            aria-label={t('mainPane.commentCountAria', { count: commentCount })}
          >
            {commentCount}
          </span>
        )}
      </button>
      {/* 草稿 tab：显示条件用总数 — 全发完仍能进 tab 看 posted/rejected 历史；
          从未创建草稿的 PR 才完全隐藏 tab，避免冗余入口 */}
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
        {commitCount !== null && commitCount > 0 && (
          <span
            className="pr-tab-badge"
            aria-label={t('mainPane.commitCountAria', { count: commitCount })}
          >
            {commitCount}
          </span>
        )}
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
