import { useEffect, useSyncExternalStore } from 'react';
import type { Config, ResolvedTheme } from '@meebox/shared';
import {
  applyEditorFontFamily,
  applyGlobalTheme,
  persistEditorTheme,
  resolveGlobalTheme,
  watchSystemThemeForAuto,
} from '../theme';
import { applyChromeFromEditorTheme } from '../theme/editor-chrome-sync';
import { setEditorAppearance, useEditorAppearance } from '../stores/editor-appearance-store';
import { invoke } from '../api';

/** After a theme is applied, push the derived window-control colors (Windows titleBarOverlay) to the main process; null falls back to generic dark/light. Fails silently. */
function syncWindowControls(colors: { color: string; symbolColor: string } | null): void {
  void invoke('window:setControlColors', colors).catch(() => {
    /* platform unsupported / main process not ready → ignore */
  });
}

/**
 * Apply the global theme: when the theme changes, resolve it to light / dark and write it to documentElement.data-theme (driving the semantic palette) + derive structural
 * chrome color overrides + persist to localStorage (for a synchronous hit on next startup); under the 'auto' theme also watch OS dark / light changes and
 * re-resolve in real time to follow.
 *
 * The theme source is a shared store (injected by useEditorAppearanceSync from config.appearance.editor_theme, with instant settings-page
 * changes synced via setEditorAppearance), so theme switching and language switching go through the same "config-driven + instant effect" path.
 */
export function useGlobalTheme(): void {
  const { editorTheme } = useEditorAppearance();
  useEffect(() => {
    applyGlobalTheme(editorTheme);
    persistEditorTheme(editorTheme);
    syncWindowControls(applyChromeFromEditorTheme(editorTheme, resolveGlobalTheme(editorTheme)));
    // 'auto' theme: on OS dark/light switch, rewrite data-theme (watch already does this) and re-derive chrome + sync window-control colors
    return watchSystemThemeForAuto(editorTheme, () => {
      syncWindowControls(applyChromeFromEditorTheme(editorTheme, resolveGlobalTheme(editorTheme)));
    });
  }, [editorTheme]);
}

/** Subscribe to documentElement.data-theme changes (including OS switches under the system preference). */
function subscribeResolvedTheme(onChange: () => void): () => void {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => obs.disconnect();
}

function getResolvedThemeSnapshot(): ResolvedTheme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/**
 * The visual theme currently in effect (resolved light / dark), updated in real time as data-theme changes. For non-CSS components that need to switch internal
 * colors by theme (e.g. the Monaco editor, Mermaid — their themes don't go through CSS custom properties and must be passed in explicitly).
 */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeResolvedTheme, getResolvedThemeSnapshot);
}

/**
 * Sync config.appearance's editor appearance to the runtime: write the shared store (read by Monaco components) + apply the monospace-font
 * CSS variable (used app-wide by $font-mono). The source is config (injected at startup, with instant settings-page changes synced via patchConfig).
 */
export function useEditorAppearanceSync(appearance: Config['appearance']): void {
  const { editor_theme, editor_font_family, editor_font_size } = appearance;
  useEffect(() => {
    setEditorAppearance({
      editorTheme: editor_theme,
      fontFamily: editor_font_family,
      fontSize: editor_font_size,
    });
    applyEditorFontFamily(editor_font_family);
  }, [editor_theme, editor_font_family, editor_font_size]);
}

/**
 * The Monaco editor theme name currently in effect: when the editor theme preference is 'auto', it follows the GUI resolved theme (light 'light-2026' / dark
 * 'dark-2026', i.e. the default 2026 colors), otherwise it uses the selected theme id.
 */
export function useMonacoEditorTheme(): string {
  const { editorTheme } = useEditorAppearance();
  const resolved = useResolvedTheme();
  if (editorTheme === 'auto') return resolved === 'light' ? 'light-2026' : 'dark-2026';
  return editorTheme;
}
