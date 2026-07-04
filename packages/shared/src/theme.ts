/** Resolved actual visual theme (the value written to data-theme). */
export type ResolvedTheme = 'light' | 'dark';

/**
 * Light / dark classification of the global theme (Monaco editor + the whole GUI chrome share one theme).
 * - `'light'` / `'dark'`: theme is constantly light / dark.
 * - `'auto'`: follows the OS dark / light setting (system dark uses Dark 2026, light uses Light 2026).
 */
export type EditorThemeMode = 'light' | 'dark' | 'auto';

/**
 * Global theme option (Monaco color theme, also drives the whole GUI chrome). `id` is the active Monaco theme name, `label` is the display name,
 * `mode` is the light / dark classification (determines `data-theme` and the native window themeSource).
 * - `'auto'`: special value, follows the system dark / light setting (dark → `dark-2026`, light → `light-2026`), the default.
 * - `vs` / `vs-dark` / `hc-light` / `hc-black`: Monaco built-in themes.
 * - The rest are built-in registered third-party themes (see renderer monaco-setup, colors from monaco-themes).
 *
 * **label is not i18n'd**: themes are proper names (GitHub Dark / Monokai…), like language endonyms, displayed
 * consistently across UI languages and not translated. **Exception**: `'auto'` is not a concrete theme but an "auto-adapt" mode, whose display text goes through i18n
 * (see settings.editorThemeOptionAuto); this label is only a fallback.
 */
export interface EditorThemeOption {
  id: string;
  label: string;
  mode: EditorThemeMode;
}

export const EDITOR_THEME_OPTIONS = [
  { id: 'auto', label: 'Auto', mode: 'auto' },
  { id: 'dark-2026', label: 'Dark 2026', mode: 'dark' },
  { id: 'light-2026', label: 'Light 2026', mode: 'light' },
  // Monaco built-in vs / vs-dark serve as the Modern defaults (no need to add VS Code Dark/Light Modern separately).
  { id: 'vs-dark', label: 'Dark Modern', mode: 'dark' },
  { id: 'vs', label: 'Light Modern', mode: 'light' },
  { id: 'hc-black', label: 'High Contrast Dark', mode: 'dark' },
  { id: 'hc-light', label: 'High Contrast Light', mode: 'light' },
  { id: 'github-light', label: 'GitHub Light', mode: 'light' },
  { id: 'github-dark', label: 'GitHub Dark', mode: 'dark' },
  { id: 'monokai', label: 'Monokai', mode: 'dark' },
  { id: 'dracula', label: 'Dracula', mode: 'dark' },
  { id: 'nord', label: 'Nord', mode: 'dark' },
  { id: 'night-owl', label: 'Night Owl', mode: 'dark' },
  { id: 'tomorrow', label: 'Tomorrow', mode: 'light' },
  { id: 'tomorrow-night', label: 'Tomorrow Night', mode: 'dark' },
  { id: 'solarized-light', label: 'Solarized Light', mode: 'light' },
  { id: 'solarized-dark', label: 'Solarized Dark', mode: 'dark' },
  { id: 'cobalt2', label: 'Cobalt2', mode: 'dark' },
  { id: 'oceanic-next', label: 'Oceanic Next', mode: 'dark' },
] as const satisfies readonly EditorThemeOption[];

export type EditorTheme = (typeof EDITOR_THEME_OPTIONS)[number]['id'];

/** Get the light / dark classification of a theme (unknown id falls back to `'auto'`). */
export function editorThemeMode(id: string): EditorThemeMode {
  return EDITOR_THEME_OPTIONS.find((o) => o.id === id)?.mode ?? 'auto';
}

/**
 * Resolve the global theme into the actual visual theme (written to data-theme). The `'auto'` theme falls to dark / light per `osPrefersDark`.
 * Shared by main / renderer: renderer's osPrefersDark comes from `prefers-color-scheme`, main's from `nativeTheme`.
 */
export function resolveEditorThemeMode(id: string, osPrefersDark: boolean): ResolvedTheme {
  const mode = editorThemeMode(id);
  return mode === 'auto' ? (osPrefersDark ? 'dark' : 'light') : mode;
}

/**
 * The native window themeSource for a theme: `'auto'` hands back to the OS (`'system'`), the rest are fixed light / dark.
 * The main process sets `nativeTheme.themeSource` accordingly, so the native window chrome (Windows thin border / window control buttons) follows the theme.
 */
export function editorThemeNativeSource(id: string): 'system' | 'light' | 'dark' {
  const mode = editorThemeMode(id);
  return mode === 'auto' ? 'system' : mode;
}

/** Tuple of supported editor theme ids (for zod enum validation). */
export const EDITOR_THEME_IDS = EDITOR_THEME_OPTIONS.map((o) => o.id) as [
  EditorTheme,
  ...EditorTheme[],
];

/** Reasonable editor font-size range (px) and default. Lower bound keeps it readable, upper bound avoids breaking the layout; default aligns with the historical 14px. */
export const EDITOR_FONT_SIZE_MIN = 8;
export const EDITOR_FONT_SIZE_MAX = 32;
export const EDITOR_FONT_SIZE_DEFAULT = 14;

/** Preset steps for the settings-page font-size dropdown (still bound by min/max above; manual config edits may use any integer in range). */
export const EDITOR_FONT_SIZE_PRESETS = [10, 11, 12, 13, 14, 15, 16, 18, 20, 24] as const;
