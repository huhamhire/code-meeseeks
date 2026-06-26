import { useTranslation } from 'react-i18next';
import { EDITOR_FONT_SIZE_PRESETS } from '@meebox/shared';

/**
 * 编辑器字体分区：代码编辑器（Monaco）等宽字体 + 字号配置。两项均即时生效（字体输入失焦才写盘，
 * onChange 实时预览），由 useAppearanceDraft 编排。本分区在「常规」内以分隔线与语言 / 主题分组。
 * 编辑器配色主题已升格为全局「主题」分区（见 ThemeSection），不在此处。
 *
 * 字体仿 VS Code `editor.fontFamily`：自由输入、可逗号分隔多个候选（按序优先），整体作为 font-family
 * 前缀拼到内置 mono 字体栈之前（拼接见 theme/resolveEditorFontFamily）。不做本机字体枚举（枚举会阻塞 UI
 * 1~2s）。
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
  // 当前字号若不在预设档位（config 手改），并入下拉、按数值排序，保证选中态可见。
  const sizeOptions = [...new Set<number>([...EDITOR_FONT_SIZE_PRESETS, fontSize])].sort(
    (a, b) => a - b,
  );

  return (
    <section className="modal-section modal-section-divider">
      {/* 字体为自由输入（可能较长的逗号分隔列表）→ 单独成行、输入框铺满，不与标题挤在一行。 */}
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
