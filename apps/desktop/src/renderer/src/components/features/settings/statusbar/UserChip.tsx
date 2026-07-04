import { useTranslation } from 'react-i18next';
import type { ConnectionSummary } from '@meebox/ipc';
import { PersonIcon } from '../../../common';

/** Summary of the logged-in user for the current connection (prefixed with the connection name when there are multiple connections). Not rendered when there is no identifiable user. */
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
