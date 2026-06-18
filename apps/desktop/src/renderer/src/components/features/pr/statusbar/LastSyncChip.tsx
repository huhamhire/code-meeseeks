import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SyncIcon } from '../../../common/icons';
import { StatusChip } from '../../../common/StatusChip';
import { formatRelative } from '../../../../utils/time';

/**
 * 刷新按钮 + 同步状态合并：一个可点击 chip，显示最近同步相对时间 + 同步图标
 * （刷新中旋转），点击触发一次轮询。
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
  // 每 30s 重渲染一次，让 "刚刚 / N 分钟前" 文案随时间向前推进
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
      ? t('statusBar.lastSyncTitle', { time: date.toLocaleString() })
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
