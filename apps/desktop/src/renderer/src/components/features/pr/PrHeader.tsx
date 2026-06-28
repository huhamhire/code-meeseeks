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
 * PR 详情头：标题 / 元信息 + 动作区（浏览器打开 · 提交评论 N · 合并 · 通过 / 需修改）。
 * 审批按钮按平台能力位降级；自己作者的 PR 不能审批（灰显 + 原因）。
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
  /** 隐藏 PR 生命周期操作（合并 + 评审决断）：已关闭范围恒置。 */
  hideLifecycle?: boolean;
  /** 内容只读（decline / 不可参与）：隐藏「提交评论 (N)」发布入口。 */
  readOnly?: boolean;
  publishableCount: number;
  onPublish: () => void;
}) {
  const { t } = useTranslation();
  // 能力位降级：reviewStatuses 决定审批按钮显隐；capabilities undefined（旧数据/无连接）时不降级。
  const reviewAllowed = (s: ReviewerStatus): boolean =>
    !capabilities || capabilities.reviewStatuses.includes(s);
  const isOwnPr = !!currentUserName && pr.author.name === currentUserName;
  const ownPrReason = isOwnPr ? t('mainPane.ownPrReason') : undefined;
  // 「我的评审」：取当前用户的 reviewer 条目（头像），角标状态用本地决断 localStatus（审批按钮即时更新，
  // 比远端 reviewer.status 更跟手）。自己作者的 PR 不可评审 → 不展示。
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
        {/* reviewer 头像栈：标题 + 元信息 band 右侧、按钮行之上，垂直居中 */}
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
        {/* approve / needs work：当前状态 = 高亮；点已高亮的回退到 pending（撤销远端标记）。
            「提交评论 (N)」放在决断按钮左边 — 评审动作分两步：先发评论 (左)，再下决断 (右)。 */}
        <div className="pr-header-actions-right">
          {/* "提交评论" 仅在有待发布草稿时渲染：N=0 时整按钮隐藏，减少 header 视觉噪音。 */}
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
          {/* 合并按钮：仅在服务端判定可合并 (canMerge) 时出现。点击直接合并（无二次确认）。只读隐藏。 */}
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
