import { useTranslation } from 'react-i18next';
import { EDITOR_THEMES, type EditorTheme } from '@meebox/shared';

/** 编辑器主题选项 → i18n key。 */
const EDITOR_THEME_OPTION_KEYS: Record<EditorTheme, string> = {
  auto: 'settings.editorThemeOptionAuto',
  vs: 'settings.editorThemeOptionVs',
  'vs-dark': 'settings.editorThemeOptionVsDark',
  'hc-black': 'settings.editorThemeOptionHcBlack',
  'hc-light': 'settings.editorThemeOptionHcLight',
};

/**
 * 编辑器外观分区：代码编辑器（Monaco）配色主题选择 + 等宽字体配置。两项均即时生效；字体输入失焦才写盘
 * （onChange 实时预览、onBlur 持久化），由 useSettingsDraft 编排。
 */
export function EditorSection({
  theme,
  fontFamily,
  onThemeChange,
  onFontChange,
  onFontCommit,
}: {
  theme: EditorTheme;
  fontFamily: string;
  onThemeChange: (next: EditorTheme) => void;
  onFontChange: (next: string) => void;
  onFontCommit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="modal-section">
      <div className="modal-section-head">
        <h4>{t('settings.editorThemeTitle')}</h4>
        <select
          className="settings-input settings-language-select"
          value={theme}
          onChange={(e) => onThemeChange(e.target.value as EditorTheme)}
          aria-label={t('settings.editorThemeTitle')}
        >
          {EDITOR_THEMES.map((code) => (
            <option key={code} value={code}>
              {t(EDITOR_THEME_OPTION_KEYS[code])}
            </option>
          ))}
        </select>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t('settings.editorThemeHint')}
      </p>
      <div className="modal-section-head" style={{ marginTop: 12 }}>
        <h4>{t('settings.editorFontTitle')}</h4>
        <input
          className="settings-input"
          type="text"
          value={fontFamily}
          placeholder={t('settings.editorFontPlaceholder')}
          onChange={(e) => onFontChange(e.target.value)}
          onBlur={onFontCommit}
          aria-label={t('settings.editorFontTitle')}
        />
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t('settings.editorFontHint')}
      </p>
    </section>
  );
}
