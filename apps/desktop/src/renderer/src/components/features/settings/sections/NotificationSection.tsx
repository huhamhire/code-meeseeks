import { useTranslation } from 'react-i18next';
import type { Config } from '@meebox/shared';
import { Switch } from '../../../common';
import { invoke } from '../../../../api';

// macOS 在系统层管控通知授权（应用无法代为开启）→ 仅 macOS 展示「打开系统通知设置」引导按钮。
const IS_MAC = navigator.platform.toLowerCase().includes('mac');

/**
 * 通知分区：总开关 + 分类型系统通知——面向评审的（新 PR / 评论回复 / 评论 @）与面向「我创建的」PR 的
 * （新评论 / 被标记需修改 / 出现冲突）。总开关关闭时下属各项禁用（灰显但保留各自值）。系统通知受 OS 权限
 * 约束——用户在系统设置关闭后应用静默降级，此处仅控制应用侧意图。macOS dock「待回应」计数角标随总开关默认
 * 启用、无独立开关，故此处不列。
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
        <li className="settings-sublist-row">
          <div className="settings-sublist-text">
            <span className="settings-sublist-label">{t('settings.notifyAuthoredCommentLabel')}</span>
            <span className="muted settings-sublist-desc">
              {t('settings.notifyAuthoredCommentHint')}
            </span>
          </div>
          <Switch
            checked={value.authored_comment}
            disabled={!on}
            onChange={(v) => set({ authored_comment: v })}
            ariaLabel={t('settings.notifyAuthoredCommentLabel')}
          />
        </li>
        <li className="settings-sublist-row">
          <div className="settings-sublist-text">
            <span className="settings-sublist-label">
              {t('settings.notifyAuthoredNeedsWorkLabel')}
            </span>
            <span className="muted settings-sublist-desc">
              {t('settings.notifyAuthoredNeedsWorkHint')}
            </span>
          </div>
          <Switch
            checked={value.authored_needs_work}
            disabled={!on}
            onChange={(v) => set({ authored_needs_work: v })}
            ariaLabel={t('settings.notifyAuthoredNeedsWorkLabel')}
          />
        </li>
        <li className="settings-sublist-row">
          <div className="settings-sublist-text">
            <span className="settings-sublist-label">
              {t('settings.notifyAuthoredConflictLabel')}
            </span>
            <span className="muted settings-sublist-desc">
              {t('settings.notifyAuthoredConflictHint')}
            </span>
          </div>
          <Switch
            checked={value.authored_conflict}
            disabled={!on}
            onChange={(v) => set({ authored_conflict: v })}
            ariaLabel={t('settings.notifyAuthoredConflictLabel')}
          />
        </li>
      </ul>
      {IS_MAC && (
        // macOS 授权引导：系统层未授权时通知会被静默丢弃，应用无法代为开启 → 提供按钮跳转系统设置由用户开启。
        <div className="settings-edit-row" style={{ marginTop: 8 }}>
          <span className="muted settings-sublist-desc" style={{ flex: 1 }}>
            {t('settings.notifyMacPermissionHint')}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void invoke('app:openNotificationSettings', undefined)}
            title={t('settings.openNotificationSettings')}
          >
            {t('settings.openNotificationSettings')}
          </button>
        </div>
      )}
    </section>
  );
}
