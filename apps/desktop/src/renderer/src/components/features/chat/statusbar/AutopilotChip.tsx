import { useTranslation } from 'react-i18next';
import { RobotIcon, RobotOffIcon, StatusChip } from '../../../common';

/**
 * AutoPilot toggle chip: off by default, click to toggle (persisted to agent.autopilot.enabled, takes effect on next poll).
 */
export function AutopilotChip({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <StatusChip
      className={`statusbar-chip-autopilot${enabled ? ' is-on' : ''}`}
      onClick={onToggle}
      ariaPressed={enabled}
      title={enabled ? t('statusBar.autopilotOnTitle') : t('statusBar.autopilotOffTitle')}
    >
      {enabled ? <RobotIcon size={13} /> : <RobotOffIcon size={13} />}
      <span>{t('statusBar.autopilot')}</span>
    </StatusChip>
  );
}
