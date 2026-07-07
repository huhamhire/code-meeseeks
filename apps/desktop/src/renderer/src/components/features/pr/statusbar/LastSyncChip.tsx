import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SyncIcon, StatusChip } from '../../../common';
import { formatRelative, formatTimestamp } from '../../../../utils/time';

/**
 * Refresh button + sync status combined: a clickable chip showing the last sync relative time + sync icon
 * (spinning while refreshing); clicking triggers one poll.
 */
export function LastSyncChip({
  at,
  refreshing,
  onRefresh,
}: {
  at: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  // Re-render every 30s so the "just now / N minutes ago" text advances with time
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const date = at ? new Date(at) : null;
  const label = refreshing ? t('statusBar.refreshing') : date ? formatRelative(date, t) : '—';
  const title = refreshing
    ? t('statusBar.refreshing')
    : date
      ? t('statusBar.lastSyncTitle', { time: formatTimestamp(date, { full: true }) })
      : t('statusBar.neverSyncedTitle');
  return (
    <StatusChip
      className={`statusbar-chip-sync statusbar-sync-btn${refreshing ? ' icon-btn-spinning' : ''}`}
      onClick={onRefresh}
      disabled={refreshing}
      title={title}
      ariaLabel={t('statusBar.refreshAria')}
    >
      <SyncIcon />
      {label}
    </StatusChip>
  );
}
