import { useTranslation } from 'react-i18next';
import type { ConnectionSummary } from '@meebox/shared';
import { PersonIcon } from '../../../common/icons';

/** 当前连接的登录用户概要（多连接时带连接名前缀）。无可识别用户时不渲染。 */
export function UserChip({ connections }: { connections: ConnectionSummary[] }) {
  const { t } = useTranslation();
  const labels = connections
    .filter((c) => c.user)
    .map((c) =>
      connections.length > 1 ? `${c.displayName}: ${c.user!.displayName}` : c.user!.displayName,
    );
  if (labels.length === 0) return null;
  const title = connections
    .map(
      (c) =>
        `${c.displayName}: ${c.user ? `${c.user.displayName} (${c.user.name})` : t('statusBar.userUnidentified')}`,
    )
    .join('\n');
  return (
    <span className="statusbar-user" title={title}>
      <PersonIcon />
      {labels.join(' · ')}
    </span>
  );
}
