import { useTranslation } from 'react-i18next';
import type { Config } from '@meebox/shared';
import { Switch } from '../../../common';

/**
 * 通知分区：总开关 + 分类型系统通知（新 PR / 评论回复 / 评论 @）。总开关关闭时下属各项禁用（灰显但保留各自
 * 值）。系统通知受 OS 权限约束——用户在系统设置关闭后应用静默降级，此处仅控制应用侧意图。macOS dock「待回应」
 * 计数角标随总开关默认启用、无独立开关，故此处不列。
 */
export function NotificationSection({
  value,
  onChange,
}: {
  value: Config['notifications'];
  onChange: (next: Config['notifications']) => void;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<Config['notifications']>): void => onChange({ ...value, ...patch });
  const on = value.enabled;
  return (
    <section className="modal-section">
      <div className="modal-section-head">
        <div className="modal-section-head-title">
          <h4>{t('settings.notificationsTitle')}</h4>
        </div>
        <Switch
          checked={value.enabled}
          onChange={(v) => set({ enabled: v })}
          ariaLabel={t('settings.notificationsEnableLabel')}
        />
      </div>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        {t('settings.notificationsHint')}
      </p>
      <ul className="settings-sublist">
        <li className="settings-sublist-row">
          <div className="settings-sublist-text">
            <span className="settings-sublist-label">{t('settings.notifyNewPrLabel')}</span>
            <span className="muted settings-sublist-desc">{t('settings.notifyNewPrHint')}</span>
          </div>
          <Switch
            checked={value.new_pr}
            disabled={!on}
            onChange={(v) => set({ new_pr: v })}
            ariaLabel={t('settings.notifyNewPrLabel')}
          />
        </li>
        <li className="settings-sublist-row">
          <div className="settings-sublist-text">
            <span className="settings-sublist-label">{t('settings.notifyReplyLabel')}</span>
            <span className="muted settings-sublist-desc">{t('settings.notifyReplyHint')}</span>
          </div>
          <Switch
            checked={value.reply}
            disabled={!on}
            onChange={(v) => set({ reply: v })}
            ariaLabel={t('settings.notifyReplyLabel')}
          />
        </li>
        <li className="settings-sublist-row">
          <div className="settings-sublist-text">
            <span className="settings-sublist-label">{t('settings.notifyMentionLabel')}</span>
            <span className="muted settings-sublist-desc">{t('settings.notifyMentionHint')}</span>
          </div>
          <Switch
            checked={value.mention}
            disabled={!on}
            onChange={(v) => set({ mention: v })}
            ariaLabel={t('settings.notifyMentionLabel')}
          />
        </li>
      </ul>
    </section>
  );
}
