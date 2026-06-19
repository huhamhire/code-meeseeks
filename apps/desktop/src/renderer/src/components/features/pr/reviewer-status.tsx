import type { ReviewerStatus } from '@meebox/shared';
import { ApproveIcon, NeedsWorkIcon } from '../../common';

/**
 * reviewer 状态的展示元信息与图标，供详情页 reviewer 列表（PrInfoView）、PR 头部头像栈
 * （ReviewerStack）等共用：状态 → 决断 chip 类型（复用活动时间线 chip 配色）+ 文案 key（复用 prStatus）。
 */
export const REVIEWER_STATUS_META: Record<ReviewerStatus, { chipKind: string; labelKey: string }> =
  {
    approved: { chipKind: 'approved', labelKey: 'prStatus.approved' },
    needsWork: { chipKind: 'needsWork', labelKey: 'prStatus.needsWork' },
    unapproved: { chipKind: 'unapproved', labelKey: 'prStatus.pending' },
  };

/** reviewer 状态图标：approve 绿勾 / needs-work 琥珀叹号 / 待评审 中性空心点。 */
export function ReviewerStatusIcon({
  status,
  size = 16,
}: {
  status: ReviewerStatus;
  size?: number;
}) {
  if (status === 'approved') return <ApproveIcon size={size} />;
  if (status === 'needsWork') return <NeedsWorkIcon size={size} />;
  return <span className="reviewer-pending-dot" />;
}
