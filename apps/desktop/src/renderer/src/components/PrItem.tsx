import { useTranslation } from 'react-i18next';
import type { AgentRecommendationVerdict, StoredPullRequest } from '@meebox/shared';
import { Avatar } from './Avatar';
import { PersonIcon, PullRequestIcon, StarIcon } from './icons';

/** 评审建议 verdict → 复用 chatPane.agent.* 文案（不另加 i18n）。 */
const VERDICT_TITLE: Record<string, string> = {
  approve: 'chatPane.agent.verdictApprove',
  needs_work: 'chatPane.agent.verdictNeedsWork',
  manual_review: 'chatPane.agent.verdictManualReview',
};

interface PrItemProps {
  pr: StoredPullRequest;
  selected: boolean;
  onClick: () => void;
  /** 评审建议倾向（手动 / AutoPilot 评审写入的台账，一视同仁）；无则不显示 ★ 徽标。 */
  reviewVerdict?: AgentRecommendationVerdict | null;
  /** 该 PR 当前有在执行的 agent 任务（工具 run 在跑 / 排队）：同位置显示蓝色「执行中」动画指示。 */
  executing?: boolean;
}

export function PrItem({ pr, selected, onClick, reviewVerdict, executing }: PrItemProps) {
  const { t } = useTranslation();
  const approvedCount = pr.reviewers.filter((r) => r.status === 'approved').length;
  const needsWorkCount = pr.reviewers.filter((r) => r.status === 'needsWork').length;
  // 服务端判定可直接合并：列表里用分支合并图标 chip 标注（纯状态，无数值）。
  // 可选链兜底：升级前持久化的 meta.json 可能尚无 mergeStatus，下一轮 poll 会补齐
  const canMerge = pr.mergeStatus?.canMerge ?? false;
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
        avatarUrl={pr.author.avatarUrl}
        size={40}
      />
      <div className="pr-item-body">
        <div className="pr-item-title">
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
              {pr.author.displayName}
            </span>
            {(approvedCount > 0 || needsWorkCount > 0 || canMerge || reviewVerdict || executing) && (
              <span className="pr-item-review-chips">
                {/* 执行中优先占位（同 ★ 位置）：复用运行卡片同款 .spinner（蓝色环旋转、中心对称），
                    裸图标无 chip 外框，表示该 PR 有在跑的 agent 任务。 */}
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
              {pr.sourceRef.displayId} → {pr.targetRef.displayId}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
