import { useTranslation } from 'react-i18next';
import {
  EDITOR_FONT_SIZE_PRESETS,
  EDITOR_THEME_OPTIONS,
  type EditorTheme,
} from '@meebox/shared';

/**
 * 编辑器外观分区：代码编辑器（Monaco）配色主题选择 + 等宽字体 + 字号配置。三项均即时生效；字体输入失焦才
 * 写盘（onChange 实时预览、onBlur 持久化），主题 / 字号离散选择即时写盘，由 useSettingsDraft 编排。
 */
export function EditorSection({
  theme,
  fontFamily,
  fontSize,
  onThemeChange,
  onFontChange,
  onFontCommit,
  onFontSizeChange,
}: {
  theme: EditorTheme;
  fontFamily: string;
  fontSize: number;
  onThemeChange: (next: EditorTheme) => void;
  onFontChange: (next: string) => void;
  onFontCommit: () => void;
  onFontSizeChange: (next: number) => void;
}) {
  const { t } = useTranslation();
  // 当前字号若不在预设档位（config 手改），并入下拉、按数值排序，保证选中态可见。
  const sizeOptions = [...new Set<number>([...EDITOR_FONT_SIZE_PRESETS, fontSize])].sort(
    (a, b) => a - b,
  );
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
          {EDITOR_THEME_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
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
      <div className="modal-section-head" style={{ marginTop: 12 }}>
        <h4>{t('settings.editorFontSizeTitle')}</h4>
        <select
          className="settings-input settings-language-select"
          value={fontSize}
          onChange={(e) => onFontSizeChange(Number(e.target.value))}
          aria-label={t('settings.editorFontSizeTitle')}
        >
          {sizeOptions.map((size) => (
            <option key={size} value={size}>
              {size} px
            </option>
          ))}
        </select>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t('settings.editorFontSizeHint')}
      </p>
    </section>
  );
}
