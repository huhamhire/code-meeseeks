import { useTranslation } from 'react-i18next';
import { RobotIcon, RobotOffIcon } from '../../../common/icons';
import { StatusChip } from '../../../common/StatusChip';

/**
 * AutoPilot 开关 chip：默认关，点击切换（持久化到 agent.autopilot.enabled，下次 poll 生效）。
 */
export function AutopilotChip({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) {
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
