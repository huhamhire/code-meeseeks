import { useTranslation } from 'react-i18next';
import { EDITOR_THEME_OPTIONS, type EditorTheme } from '@meebox/shared';

/**
 * Global theme section: pick the app theme (Monaco color theme, also drives the whole GUI chrome and light / dark semantic palette).
 * 'auto' (auto-adapt to system) goes through i18n; other themes use proper names (GitHub Dark / Monokai…, consistent across UI languages, not translated).
 */
export function ThemeSection({
  theme,
  onChange,
}: {
  theme: EditorTheme;
  onChange: (next: EditorTheme) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="modal-section">
      <div className="modal-section-head">
        <h4>{t('settings.themeTitle')}</h4>
        <select
          className="settings-input settings-language-select"
          value={theme}
          onChange={(e) => onChange(e.target.value as EditorTheme)}
          aria-label={t('settings.themeTitle')}
        >
          {EDITOR_THEME_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.id === 'auto' ? t('settings.editorThemeOptionAuto') : opt.label}
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
