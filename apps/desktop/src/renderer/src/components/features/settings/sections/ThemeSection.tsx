import { useTranslation } from 'react-i18next';
import { EDITOR_THEME_OPTIONS, type EditorTheme } from '@meebox/shared';

/**
 * 全局主题分区：选择应用主题（Monaco 配色主题，亦驱动整个 GUI chrome 与浅 / 深语义色板）。
 * 'auto'（自动适应系统）走 i18n、其余主题用专名（GitHub Dark / Monokai…，各 UI 语言一致不翻译）。
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
