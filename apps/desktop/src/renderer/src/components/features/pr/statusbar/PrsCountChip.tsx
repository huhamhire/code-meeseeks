import { useTranslation } from 'react-i18next';
import { PullRequestIcon, StatusChip } from '../../../common';

/** Pending PR count chip. */
export function PrsCountChip({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <StatusChip
      className="statusbar-chip-prs"
      title={t('statusBar.pendingPrsCount', { n: count })}
      ariaLabel={`PRs ${String(count)}`}
    >
      <PullRequestIcon />
      {count}
    </StatusChip>
  );
}
