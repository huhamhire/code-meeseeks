import { useTranslation } from 'react-i18next';
import { Switch } from '../../../common';

/**
 * Agent 策略：扩展 Agent 行为控制的分区，子项以缩进的「功能列表」逐行展示（行首圆点 + 标题 + 说明，
 * 右侧控件）。右侧控件不限于开关，后续可为下拉 / 滑块等（用通用 .settings-sublist-* 结构）。
 * 后续策略项在此追加一行即可。本期一项：自动追问（agent.strategy.auto_followup）。
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
      <ul className="settings-sublist">
        <li className="settings-sublist-row">
          <div className="settings-sublist-text">
            <span className="settings-sublist-label">{t('settings.autoFollowupLabel')}</span>
            <span className="muted settings-sublist-desc">{t('settings.autoFollowupHint')}</span>
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
