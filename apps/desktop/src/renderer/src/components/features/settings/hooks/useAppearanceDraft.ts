import { useState } from 'react';
import type { Config, EditorTheme, SupportedLanguage, ThemePreference } from '@meebox/shared';
import { EDITOR_FONT_SIZE_MAX, EDITOR_FONT_SIZE_MIN } from '@meebox/shared';
import { invoke } from '../../../../api';
import i18n, { persistLanguage, resolveUiLanguage } from '../../../../i18n';
import { applyEditorFontFamily, applyThemePreference, persistThemePreference } from '../../../../theme';
import { setEditorAppearance } from '../../../../stores/editor-appearance-store';

interface UseAppearanceDraftParams {
  config: Config;
  onLanguageChange?: (language: SupportedLanguage) => void;
  onThemeChange?: (theme: ThemePreference) => void;
  onEditorAppearanceChange?: (appearance: {
    editor_theme: EditorTheme;
    editor_font_family: string;
    editor_font_size: number;
  }) => void;
}

/**
 * 外观类「即时生效」设置：UI 语言 / GUI 主题 / 编辑器外观（Monaco 主题 + 等宽字体 + 字号）。
 * 与 useSettingsDraft 的「草稿 → 整体保存」事务相互正交 —— 这里每项改即生效：实时应用到运行时
 * （data-theme / store / CSS 变量）+ 持久化（localStorage + 写盘）+ 同步父级，不进 base/saveAll。
 * 写盘失败不回滚 UI（已切），仅经 error 提示；下次启动按 localStorage 兜底。
 */
export function useAppearanceDraft({
  config,
  onLanguageChange,
  onThemeChange,
  onEditorAppearanceChange,
}: UseAppearanceDraftParams) {
  // 即时生效项写盘失败的错误（与整体保存的 saveError 分开，由 SettingsModal 合并展示）
  const [error, setError] = useState<string | null>(null);

  // UI 语言：即时生效项（不走全局保存）
  const [language, setLanguage] = useState<SupportedLanguage>(() => resolveUiLanguage(config.language));
  const handleLanguageChange = (next: SupportedLanguage): void => {
    if (next === language) return;
    setLanguage(next);
    void i18n.changeLanguage(next); // 渲染层实时切换
    persistLanguage(next); // localStorage 缓存，下次启动同步命中
    onLanguageChange?.(next); // 同步父级 boot.config.language
    invoke('config:setLanguage', { language: next }).catch((e: unknown) => {
      // 写盘 / 主进程切换失败不回滚 UI（已切），仅提示；下次启动按 localStorage 兜底
      setError(e instanceof Error ? e.message : String(e));
    });
  };

  // GUI 主题：与语言同属即时生效项（不走全局保存）。改即写 data-theme + 持久化 + 同步父级 + 写盘。
  const [themePreference, setThemePreference] = useState<ThemePreference>(config.appearance.theme);
  const handleThemeChange = (next: ThemePreference): void => {
    if (next === themePreference) return;
    setThemePreference(next);
    applyThemePreference(next); // 渲染层实时切换（写 documentElement data-theme）
    persistThemePreference(next); // localStorage 缓存，下次启动同步命中
    onThemeChange?.(next); // 同步父级 boot.config.appearance.theme
    invoke('config:setTheme', { theme: next }).catch((e: unknown) => {
      // 写盘失败不回滚 UI（已切），仅提示；下次启动按 localStorage 兜底
      setError(e instanceof Error ? e.message : String(e));
    });
  };

  // 编辑器外观（Monaco 主题 + 等宽字体）：即时生效项。主题为离散选择 → 改即写盘；字体为文本输入 →
  // onChange 仅实时预览（写 store + CSS + 同步父级），onBlur 才写盘，避免逐字符落盘。
  const [editorTheme, setEditorTheme] = useState<EditorTheme>(config.appearance.editor_theme);
  const [editorFontFamily, setEditorFontFamily] = useState<string>(
    config.appearance.editor_font_family,
  );
  const [editorFontSize, setEditorFontSizeState] = useState<number>(
    config.appearance.editor_font_size,
  );
  // 实时应用到运行时：写共享 store（Monaco 组件读）+ 字体 CSS 变量（全应用 $font-mono）+ 同步父级。
  const applyEditorAppearance = (nextTheme: EditorTheme, nextFont: string, nextSize: number): void => {
    setEditorAppearance({ editorTheme: nextTheme, fontFamily: nextFont, fontSize: nextSize });
    applyEditorFontFamily(nextFont);
    onEditorAppearanceChange?.({
      editor_theme: nextTheme,
      editor_font_family: nextFont,
      editor_font_size: nextSize,
    });
  };
  const persistEditorAppearance = (nextTheme: EditorTheme, nextFont: string, nextSize: number): void => {
    invoke('config:setEditorAppearance', {
      editor_theme: nextTheme,
      editor_font_family: nextFont,
      editor_font_size: nextSize,
    }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const handleEditorThemeChange = (next: EditorTheme): void => {
    if (next === editorTheme) return;
    setEditorTheme(next);
    applyEditorAppearance(next, editorFontFamily, editorFontSize);
    persistEditorAppearance(next, editorFontFamily, editorFontSize);
  };
  const handleEditorFontChange = (next: string): void => {
    setEditorFontFamily(next);
    applyEditorAppearance(editorTheme, next, editorFontSize); // 实时预览，不写盘
  };
  const commitEditorFont = (): void => {
    persistEditorAppearance(editorTheme, editorFontFamily, editorFontSize); // 失焦才写盘
  };
  // 字号为离散下拉 → 改即生效并写盘；clamp 防越界（异常 / config 手改超范围）。
  const handleEditorFontSizeChange = (next: number): void => {
    const clamped = Math.min(EDITOR_FONT_SIZE_MAX, Math.max(EDITOR_FONT_SIZE_MIN, Math.round(next)));
    if (clamped === editorFontSize) return;
    setEditorFontSizeState(clamped);
    applyEditorAppearance(editorTheme, editorFontFamily, clamped);
    persistEditorAppearance(editorTheme, editorFontFamily, clamped);
  };

  return {
    // 语言
    language,
    handleLanguageChange,
    // 主题
    themePreference,
    handleThemeChange,
    // 编辑器外观
    editorTheme,
    editorFontFamily,
    editorFontSize,
    handleEditorThemeChange,
    handleEditorFontChange,
    commitEditorFont,
    handleEditorFontSizeChange,
    // 即时生效项写盘错误
    error,
  };
}
