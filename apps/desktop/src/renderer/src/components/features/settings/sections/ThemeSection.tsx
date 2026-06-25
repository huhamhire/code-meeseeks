import { useTranslation } from 'react-i18next';
import { THEME_PREFERENCES, type ThemePreference } from '@meebox/shared';

/** 主题偏好选项 → i18n key（选项文案随 UI 语言翻译，区别于语言项的 endonym）。 */
const THEME_OPTION_KEYS: Record<ThemePreference, string> = {
  system: 'settings.themeOptionSystem',
  light: 'settings.themeOptionLight',
  dark: 'settings.themeOptionDark',
};

export function ThemeSection({
  theme,
  onChange,
}: {
  theme: ThemePreference;
  onChange: (next: ThemePreference) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="modal-section">
      <div className="modal-section-head">
        <h4>{t('settings.themeTitle')}</h4>
        <select
          className="settings-input settings-language-select"
          value={theme}
          onChange={(e) => onChange(e.target.value as ThemePreference)}
          aria-label={t('settings.themeTitle')}
        >
          {THEME_PREFERENCES.map((code) => (
            <option key={code} value={code}>
              {t(THEME_OPTION_KEYS[code])}
            </option>
          ))}
        </select>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t('settings.themeHint')}
      </p>
    </section>
  );
}
