import { useTranslation } from 'react-i18next';
import { ChatIcon, PersonIcon, WhitespaceIcon } from '../../../common';

export type PrTab = 'diff' | 'activity' | 'drafts' | 'commits' | 'info';

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
  /** 该平台是否提供活动时间线（见 capabilities.activityTimeline）；否则该 tab 标题退化为「评论」 */
  activityTimeline: boolean;
  /** 内容只读（decline / 不可参与归档 PR）：隐藏「新建评论」入口。 */
  readOnly?: boolean;
  /** 活动标签页右侧「评论」按钮：新建一条不锚到文件的评论 */
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
      {/* 活动时间线（评论 + 提交 + 评审决断）在 commits 前：评审决断时讨论权重大于纯 commit 列表。
          角标仍取评论数——讨论量最具行动指引，提交另有独立 tab 计数。 */}
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
 * tab 计数角标。计数异步加载（评论 / 提交）：
 * - `null`（加载中）：渲染等宽占位 chip，预留角标宽度，消除计数到达时 tab 的横向弹簧抖动；
 * - `> 0`：真实数字角标；
 * - `0`：不渲染（无角标）。
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
