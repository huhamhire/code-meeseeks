import { useTranslation } from 'react-i18next';
import { Switch } from '../../../common';

/**
 * Agent 策略：扩展 Agent 行为控制开关的分区，子项以「功能列表」形式逐行展示（左侧标题 + 说明，右侧 Switch）。
 * 后续行为开关在此追加一行即可。本期一项：自动追问（agent.strategy.auto_followup）。
 */
export function AgentStrategySection({
  autoFollowup,
  onAutoFollowupChange,
}: {
  autoFollowup: boolean;
  onAutoFollowupChange: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="modal-section modal-section-divider">
      <h4>{t('settings.agentStrategyTitle')}</h4>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        {t('settings.agentStrategyHint')}
      </p>
      <ul className="settings-toggle-list">
        <li className="settings-toggle-row">
          <div className="settings-toggle-text">
            <span className="settings-toggle-label">{t('settings.autoFollowupLabel')}</span>
            <span className="muted settings-toggle-desc">{t('settings.autoFollowupHint')}</span>
          </div>
          <Switch
            checked={autoFollowup}
            onChange={onAutoFollowupChange}
            ariaLabel={t('settings.autoFollowupLabel')}
          />
        </li>
      </ul>
    </section>
  );
}
