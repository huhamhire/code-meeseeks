import { useTranslation } from 'react-i18next';
import { EDITOR_FONT_SIZE_PRESETS } from '@meebox/shared';

/**
 * Editor font section: code editor (Monaco) monospace font + font size config. Both take effect immediately (the font
 * input only writes to disk on blur, onChange live-previews), orchestrated by useAppearanceDraft. This section is grouped
 * under "General" with a divider alongside language / theme.
 * The editor color theme has been promoted to the global "theme" section (see ThemeSection), not here.
 *
 * The font mimics VS Code `editor.fontFamily`: free input, comma-separated multiple candidates (prioritized in order), the
 * whole thing prepended as a font-family prefix before the built-in mono font stack (see theme/resolveEditorFontFamily for
 * the concatenation). No local font enumeration (enumeration would block the UI for 1~2s).
 */
export function EditorSection({
  fontFamily,
  fontSize,
  onFontChange,
  onFontCommit,
  onFontSizeChange,
}: {
  fontFamily: string;
  fontSize: number;
  onFontChange: (next: string) => void;
  onFontCommit: () => void;
  onFontSizeChange: (next: number) => void;
}) {
  const { t } = useTranslation();
  // If the current font size isn't among the preset tiers (hand-edited config), merge it into the dropdown and sort by value, ensuring the selected state is visible.
  const sizeOptions = [...new Set<number>([...EDITOR_FONT_SIZE_PRESETS, fontSize])].sort(
    (a, b) => a - b,
  );

  return (
    <section className="modal-section modal-section-divider">
      {/* The font is free input (possibly a long comma-separated list) → on its own row with the input filling the width, not crammed onto the title row. */}
      <div className="settings-field-stacked">
        <h4>{t('settings.editorFontTitle')}</h4>
        <input
          className="settings-input settings-input-block"
          type="text"
          value={fontFamily}
          placeholder={t('settings.editorFontPlaceholder')}
          onChange={(e) => onFontChange(e.target.value)}
          onBlur={onFontCommit}
          aria-label={t('settings.editorFontTitle')}
        />
      </div>
      <p className="muted" style={{ margin: '6px 0 0' }}>
        {t('settings.editorFontHint')}
      </p>
      <div className="modal-section-head" style={{ marginTop: 20 }}>
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
