import { useTranslation } from 'react-i18next';
import type { Config } from '@meebox/shared';
import { Switch } from '../../../common';
import { invoke } from '../../../../api';

// macOS gates notification authorization at the system level (the app can't enable it on the user's behalf) → only macOS shows the "Open system notification settings" guidance button.
const IS_MAC = navigator.platform.toLowerCase().includes('mac');

/**
 * Notification section: master switch + per-type system notifications — review-facing ones (new PR /
 * comment reply / comment @) and "my authored" PR ones (new comment / marked needs-work / conflict
 * appeared). When the master switch is off the sub-items are disabled (grayed out but keep their own
 * values). System notifications are subject to OS permission — once the user disables them in system
 * settings the app silently degrades; this only controls the app-side intent. The macOS dock
 * "awaiting response" count badge is enabled by default with the master switch, has no independent
 * switch, and so is not listed here.
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
        // macOS authorization guidance: when unauthorized at the system level notifications are silently dropped and the app can't enable it on the user's behalf → provide a button to jump to system settings for the user to enable.
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
