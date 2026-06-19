import { useTranslation } from 'react-i18next';
import { PullRequestIcon, StatusChip } from '../../../common';

/** 待处理 PR 计数 chip。 */
export function PrsCountChip({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <StatusChip
      tone="ok"
      className="statusbar-chip-prs"
      title={t('statusBar.pendingPrsCount', { n: count })}
      ariaLabel={`PRs ${String(count)}`}
    >
      <PullRequestIcon />
      {count}
    </StatusChip>
  );
}
