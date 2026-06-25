import { useTranslation } from 'react-i18next';
import { Switch } from '../../../common';

// 代码建议数量上限可选档位（2~8）。
const MAX_CODE_SUGGESTIONS_OPTIONS = [2, 3, 4, 5, 6, 7, 8];

/**
 * Agent 策略：扩展 Agent 行为控制的分区，子项以缩进的「功能列表」逐行展示（行首圆点 + 标题 + 说明，
 * 右侧控件）。右侧控件不限于开关——自动追问用 Switch，代码建议数量用下拉（同一通用 .settings-sublist-*）。
 * 后续策略项在此追加一行即可。
 */
export function AgentStrategySection({
  autoFollowup,
  onAutoFollowupChange,
  maxCodeSuggestions,
  onMaxCodeSuggestionsChange,
}: {
  autoFollowup: boolean;
  onAutoFollowupChange: (next: boolean) => void;
  maxCodeSuggestions: number;
  onMaxCodeSuggestionsChange: (next: number) => void;
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
        <li className="settings-sublist-row">
          <div className="settings-sublist-text">
            <span className="settings-sublist-label">{t('settings.maxCodeSuggestionsLabel')}</span>
            <span className="muted settings-sublist-desc">
              {t('settings.maxCodeSuggestionsHint')}
            </span>
          </div>
          <select
            className="settings-input settings-sublist-select"
            value={maxCodeSuggestions}
            onChange={(e) => onMaxCodeSuggestionsChange(Number.parseInt(e.target.value, 10))}
            aria-label={t('settings.maxCodeSuggestionsLabel')}
          >
            {MAX_CODE_SUGGESTIONS_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </li>
      </ul>
    </section>
  );
}
