// GUI chrome follows the global theme: derive "structural neutral tokens" (background / foreground / border /
// selection) from the current Monaco theme and override them on documentElement, so the whole chrome shares the
// editor's theme.
//
// Hybrid approach (not "fully eliminate the light/dark palette"): only derive structural neutral colors; semantic
// colors (accent / approved / warning / danger / chip / file status dots, etc.) are still self-managed by
// _theme.scss's semantic layer per data-theme light / dark — the editor theme has no such product semantic colors
// and they need contrast guarantees.
//
// Data reality: third-party monaco-themes carry only a handful of keys such as editor.background / foreground /
// selectionBackground (see monaco-setup getEditorThemeColors). So muted text / each background level / borders are
// all derived from fg↔bg mixing, with a contrast floor added to secondary text (fadeWithFloor) to keep low-contrast
// themes (like Solarized) from breaking readability.
//
// When no color is available / bg·fg is missing, clear the overrides and fall back to the pure semantic palette
// (still displays normally per data-theme light / dark).

import { getEditorThemeColors } from '../lib/monaco-setup';

/** All CSS custom properties this module overrides (removed one by one on cleanup, falling back to _theme.scss's semantic palette). */
const OVERRIDDEN_VARS = [
  '--bg-app',
  '--bg-panel',
  '--bg-panel-alt',
  '--bg-elev',
  '--bg-surface',
  '--bg-hover',
  '--text-primary',
  '--text-body',
  '--text-muted',
  '--text-subtle',
  '--text-dim',
  '--border-default',
  '--border-default-fade',
  '--border-muted',
  '--bg-selected',
  '--bg-group-header',
] as const;

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parse #rgb / #rgba / #rrggbb / #rrggbbaa; return null on failure. */
function parseHex(hex: string): Rgb | null {
  const h = hex.trim().replace(/^#/, '');
  const expand = (s: string): string =>
    s.length === 3 || s.length === 4
      ? s
          .split('')
          .map((c) => c + c)
          .join('')
      : s;
  const x = expand(h);
  if (x.length !== 6 && x.length !== 8) return null;
  const r = Number.parseInt(x.slice(0, 2), 16);
  const g = Number.parseInt(x.slice(2, 4), 16);
  const b = Number.parseInt(x.slice(4, 6), 16);
  const a = x.length === 8 ? Number.parseInt(x.slice(6, 8), 16) / 255 : 1;
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  return { r, g, b, a };
}

/** Linearly interpolate between c1 → c2 by t (0..1) (alpha ignored, result opaque). */
function mix(c1: Rgb, c2: Rgb, t: number): Rgb {
  return {
    r: Math.round(c1.r + (c2.r - c1.r) * t),
    g: Math.round(c1.g + (c2.g - c1.g) * t),
    b: Math.round(c1.b + (c2.b - c1.b) * t),
    a: 1,
  };
}

function toRgbString({ r, g, b, a }: Rgb): string {
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgb(${r} ${g} ${b} / ${a.toFixed(3)})`;
}

/** Convert to #rrggbb (alpha ignored); for Windows titleBarOverlay (its color takes hex). */
function toHex({ r, g, b }: Rgb): string {
  const h = (v: number): string => v.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Relative luminance (WCAG). */
function luminance({ r, g, b }: Rgb): number {
  const ch = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** Contrast ratio (WCAG, 1..21). */
function contrastRatio(c1: Rgb, c2: Rgb): number {
  const l1 = luminance(c1);
  const l2 = luminance(c2);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * "Text fade" with a contrast floor: intends to mix fg toward bg by desiredT (larger = fainter), but walks
 * desiredT back toward 0 until the result's contrast against bg is ≥ floor — ensuring secondary text isn't faded
 * to unreadable under low-contrast themes (like Solarized). The cost is that in low-contrast themes muted collapses
 * back to ≈fg (same weight as primary text), an honest readability-first tradeoff.
 */
function fadeWithFloor(fg: Rgb, bg: Rgb, desiredT: number, floor: number): Rgb {
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const t = desiredT * (1 - i / steps);
    const c = mix(fg, bg, t);
    if (contrastRatio(c, bg) >= floor) return c;
  }
  return fg;
}

const WHITE: Rgb = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgb = { r: 0, g: 0, b: 0, a: 1 };

function clearChromeOverrides(): void {
  const root = document.documentElement.style;
  for (const v of OVERRIDDEN_VARS) root.removeProperty(v);
}

/**
 * Derive the current global theme's base colors into structural tokens for the GUI chrome and write them to
 * documentElement (overriding _theme.scss). When no color is available / bg·fg is missing, clear the overrides and
 * fall back to the semantic palette (still displays normally per data-theme light / dark).
 */
export function applyChromeFromEditorTheme(
  editorThemeId: string,
  resolvedGuiTheme: 'light' | 'dark',
): { color: string; symbolColor: string } | null {
  // 'auto' follows the resolved theme → take the default 2026 theme's (dark-2026 / light-2026) base color
  const effectiveId =
    editorThemeId === 'auto' ? (resolvedGuiTheme === 'dark' ? 'dark-2026' : 'light-2026') : editorThemeId;
  const data = getEditorThemeColors(effectiveId);
  const bg = data && parseHex(data.colors['editor.background'] ?? '');
  const fg = data && parseHex(data.colors['editor.foreground'] ?? '');
  if (!bg || !fg) {
    clearChromeOverrides();
    console.warn('[chrome-sync] no usable bg/fg for theme, fell back to semantic palette:', effectiveId);
    return null;
  }
  const isDark = luminance(bg) < 0.5;
  const edge = isDark ? WHITE : BLACK; // elevation layer (the more a background "floats" the closer to this edge) / border mix direction
  const sel = parseHex(data?.colors['editor.selectionBackground'] ?? '') ?? mix(bg, edge, 0.16);

  // Each background level: editor.background as baseline, lifted slightly toward edge by elevation
  const bgPanel = mix(bg, edge, 0.03);
  const bgPanelAlt = mix(bg, edge, 0.06);
  const bgElev = mix(bg, edge, 0.05);
  const bgSurface = mix(bg, edge, 0.08);
  const bgHover = mix(bg, edge, 0.1);
  // Each text level: fade editor.foreground toward bg into muted / subtle / dim, each with a contrast floor to keep low-contrast themes from breaking through
  const textMuted = fadeWithFloor(fg, bg, 0.45, 4.5);
  const textSubtle = fadeWithFloor(fg, bg, 0.52, 4.0);
  const textDim = fadeWithFloor(fg, bg, 0.6, 3.0);
  // Border: fade fg heavily toward bg, leaving a very faint outline
  const borderDefault = mix(fg, bg, 0.8);
  const borderMuted = mix(fg, bg, 0.88);
  const borderFade = { ...borderDefault, a: 0.5 };
  // Group header: sink slightly toward black (a "recessed" title band slightly darker than bg-app, hover lifts up via --bg-panel), derived per theme.
  const bgGroupHeader = mix(bg, BLACK, 0.12);

  const set = (name: string, c: Rgb): void => document.documentElement.style.setProperty(name, toRgbString(c));
  set('--bg-app', bg);
  set('--bg-panel', bgPanel);
  set('--bg-panel-alt', bgPanelAlt);
  set('--bg-elev', bgElev);
  set('--bg-surface', bgSurface);
  set('--bg-hover', bgHover);
  set('--text-primary', fg);
  set('--text-body', fg);
  set('--text-muted', textMuted);
  set('--text-subtle', textSubtle);
  set('--text-dim', textDim);
  set('--border-default', borderDefault);
  set('--border-muted', borderMuted);
  set('--border-default-fade', borderFade);
  set('--bg-selected', sel);
  set('--bg-group-header', bgGroupHeader);

  // Readability check: contrast of muted text / weak border against background (AA body text ≥4.5, secondary/non-text ≥3)
  const mutedCr = contrastRatio(textMuted, bg);
  const borderCr = contrastRatio(borderDefault, bg);
  console.info(
    `[chrome-sync] "${effectiveId}" (${isDark ? 'dark' : 'light'}) → muted/bg contrast ${mutedCr.toFixed(2)} (AA≥4.5), border/bg ${borderCr.toFixed(2)} (≥3)`,
  );
  // Match window control buttons: hand the theme base background / foreground (hex) back to the main process to update Windows titleBarOverlay (see useGlobalTheme).
  return { color: toHex(bg), symbolColor: toHex(fg) };
}
