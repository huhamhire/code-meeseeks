import { resolveEditorThemeMode, editorThemeMode, type ResolvedTheme } from '@meebox/shared';

/**
 * Renderer theme runtime.
 *
 * The global theme (the Monaco editor + the entire GUI chrome share one theme, see @meebox/shared EDITOR_THEME_OPTIONS) is resolved to
 * light / dark and written to `documentElement`'s `data-theme`; semantic colors switch wholesale via CSS custom properties (default :root = dark,
 * `[data-theme='light']` overrides to light, see styles/_theme.scss). Structural chrome colors are separately overridden as derived from the theme (see
 * editor-chrome-sync). This module only handles data-theme + fonts, and doesn't import Monaco (to keep the first frame lightweight).
 *
 * - The theme arrives asynchronously via IPC (config.appearance.editor_theme), unavailable at startup; localStorage can be read synchronously, so it's used as
 *   the first-frame initial theme to avoid a wrong-theme flash on startup. After App gets config it persists it back, for a direct hit on next startup.
 * - When the theme mode is 'auto' it follows `prefers-color-scheme`, and watchSystemThemeForAuto re-resolves in real time on OS switches.
 * - The default theme is **auto** (auto-adapt to the system): falls back to 'auto' when localStorage has no record / is unavailable.
 */

const EDITOR_THEME_STORAGE_KEY = 'meebox.editorTheme';
const DEFAULT_EDITOR_THEME = 'auto';

/** Whether the OS prefers dark ('auto' theme resolves based on this). Conservatively assumes dark when matchMedia is unavailable. */
function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
}

/** Resolve a global theme id to the actual visual theme ('auto' lands on OS dark / light). */
export function resolveGlobalTheme(editorTheme: string): ResolvedTheme {
  return resolveEditorThemeMode(editorTheme, systemPrefersDark());
}

/** Read the localStorage-cached theme as the first-frame initial value; falls back to the default (auto) when there's no record / it's unavailable. */
export function readInitialEditorTheme(): string {
  try {
    return localStorage.getItem(EDITOR_THEME_STORAGE_KEY) ?? DEFAULT_EDITOR_THEME;
  } catch {
    return DEFAULT_EDITOR_THEME;
  }
}

/** Persist the theme to localStorage, for synchronous reading as the initial theme on next startup. */
export function persistEditorTheme(editorTheme: string): void {
  try {
    localStorage.setItem(EDITOR_THEME_STORAGE_KEY, editorTheme);
  } catch {
    // Ignore when localStorage is unavailable: only affects the initial theme hit on next startup, not functionality.
  }
}

/** Resolve the global theme to light / dark, then write it to documentElement.data-theme, triggering a wholesale semantic palette switch. */
export function applyGlobalTheme(editorTheme: string): void {
  document.documentElement.dataset.theme = resolveGlobalTheme(editorTheme);
}

/**
 * Watch OS dark / light changes. Needed only for the 'auto' theme: re-resolve in real time on OS switch and rewrite data-theme.
 * Returns an unsubscribe function; non-'auto' themes just return an empty cleanup (no watching).
 */
export function watchSystemThemeForAuto(editorTheme: string, onChange: () => void): () => void {
  if (editorThemeMode(editorTheme) !== 'auto') return () => {};
  let mq: MediaQueryList;
  try {
    mq = window.matchMedia('(prefers-color-scheme: dark)');
  } catch {
    return () => {};
  }
  const handler = (): void => {
    applyGlobalTheme(editorTheme);
    onChange();
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

// Built-in monospace fallback stack: placed after the user's custom font, ensuring a fall-back to a reasonable mono font when glyphs are missing.
const MONO_FALLBACK = "'Cascadia Code', 'Consolas', ui-monospace, monospace";

/** Resolve the user-configured font family to a full font-family string (appending the fallback stack); empty config returns undefined (uses the default). */
export function resolveEditorFontFamily(font: string): string | undefined {
  const f = font.trim();
  return f ? `${f}, ${MONO_FALLBACK}` : undefined;
}

/**
 * Apply the editor monospace font app-wide: write documentElement's `--editor-font-family` custom property ($font-mono takes
 * its value from it, covering all monospace text such as diff / comments / code blocks). When config is empty, remove the property and fall back to the built-in mono font stack.
 * The Monaco editor content font is set separately via its fontFamily option (see DiffPane / InlineCodeContext).
 */
export function applyEditorFontFamily(font: string): void {
  const resolved = resolveEditorFontFamily(font);
  if (resolved) document.documentElement.style.setProperty('--editor-font-family', resolved);
  else document.documentElement.style.removeProperty('--editor-font-family');
}

// Side effect: on module import, set the first-frame theme from the localStorage cache (before React renders), avoiding a wrong-theme flash on startup.
applyGlobalTheme(readInitialEditorTheme());
