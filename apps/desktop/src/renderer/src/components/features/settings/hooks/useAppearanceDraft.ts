import { useState } from 'react';
import type { Config, EditorTheme, SupportedLanguage } from '@meebox/shared';
import { EDITOR_FONT_SIZE_MAX, EDITOR_FONT_SIZE_MIN } from '@meebox/shared';
import { invoke } from '../../../../api';
import i18n, { persistLanguage, resolveUiLanguage } from '../../../../i18n';
import { applyEditorFontFamily } from '../../../../theme';
import { setEditorAppearance } from '../../../../stores/editor-appearance-store';

interface UseAppearanceDraftParams {
  config: Config;
  onLanguageChange?: (language: SupportedLanguage) => void;
  onEditorAppearanceChange?: (appearance: {
    editor_theme: EditorTheme;
    editor_font_family: string;
    editor_font_size: number;
  }) => void;
}

/**
 * Appearance "instant-effect" settings: UI language / global theme + editor font (Monaco theme is the global theme, plus monospace font + size).
 * Orthogonal to useSettingsDraft's "draft → save-all" transaction —— here each change takes effect immediately: applied to the runtime in real time
 * (store / data-theme / chrome / CSS variables) + persisted (localStorage + written to disk) + synced to parent, not part of base/saveAll.
 * Write-to-disk failure does not roll back the UI (already switched), only surfaces via error; next startup falls back to localStorage. The data-theme /
 * chrome derivation of theme switching is driven by App's useGlobalTheme subscribing to store changes (see hooks/useTheme).
 */
export function useAppearanceDraft({
  config,
  onLanguageChange,
  onEditorAppearanceChange,
}: UseAppearanceDraftParams) {
  // Error from write-to-disk failure of instant-effect items (kept separate from save-all's saveError, merged for display by SettingsModal)
  const [error, setError] = useState<string | null>(null);

  // UI language: instant-effect item (does not go through save-all)
  const [language, setLanguage] = useState<SupportedLanguage>(() => resolveUiLanguage(config.language));
  const handleLanguageChange = (next: SupportedLanguage): void => {
    if (next === language) return;
    setLanguage(next);
    void i18n.changeLanguage(next); // switch the renderer layer in real time
    persistLanguage(next); // localStorage cache, hit synchronously on next startup
    onLanguageChange?.(next); // sync parent boot.config.language
    invoke('config:setLanguage', { language: next }).catch((e: unknown) => {
      // Write-to-disk / main-process switch failure does not roll back the UI (already switched), only surfaces; next startup falls back to localStorage
      setError(e instanceof Error ? e.message : String(e));
    });
  };

  // Global theme (Monaco theme + monospace font): instant-effect items. Theme is a discrete choice → written to disk on change; font is text input →
  // onChange only previews in real time (writes store + CSS + syncs parent), onBlur writes to disk, avoiding per-character disk writes.
  const [editorTheme, setEditorTheme] = useState<EditorTheme>(config.appearance.editor_theme);
  const [editorFontFamily, setEditorFontFamily] = useState<string>(
    config.appearance.editor_font_family,
  );
  const [editorFontSize, setEditorFontSizeState] = useState<number>(
    config.appearance.editor_font_size,
  );
  // Apply to runtime in real time: write shared store (read by Monaco component) + font CSS variable (app-wide $font-mono) + sync parent.
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
    applyEditorAppearance(editorTheme, next, editorFontSize); // real-time preview, not written to disk
  };
  const commitEditorFont = (): void => {
    persistEditorAppearance(editorTheme, editorFontFamily, editorFontSize); // written to disk only on blur
  };
  // Font size is a discrete dropdown → takes effect and written to disk on change; clamp guards against out-of-range (anomaly / manually edited config out of range).
  const handleEditorFontSizeChange = (next: number): void => {
    const clamped = Math.min(EDITOR_FONT_SIZE_MAX, Math.max(EDITOR_FONT_SIZE_MIN, Math.round(next)));
    if (clamped === editorFontSize) return;
    setEditorFontSizeState(clamped);
    applyEditorAppearance(editorTheme, editorFontFamily, clamped);
    persistEditorAppearance(editorTheme, editorFontFamily, clamped);
  };

  return {
    // language
    language,
    handleLanguageChange,
    // global theme + editor font
    editorTheme,
    editorFontFamily,
    editorFontSize,
    handleEditorThemeChange,
    handleEditorFontChange,
    commitEditorFont,
    handleEditorFontSizeChange,
    // write-to-disk error of instant-effect items
    error,
  };
}
