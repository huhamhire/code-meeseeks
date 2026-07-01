// GUI chrome 跟随全局主题：从当前 Monaco 主题派生「结构性中性 token」（背景 / 前景 / 边框 / 选区）覆盖
// 到 documentElement，使整个 chrome 与编辑器同主题。
//
// 混合方案（非「完全消除浅深色板」）：只派生结构性中性色；语义色（accent / approved / warning / danger /
// chip / 文件状态点等）仍由 _theme.scss 的语义层按 data-theme 浅 / 深自管 —— 编辑器主题里没有这些产品
// 语义色、且需对比度保证。
//
// 数据现实：第三方 monaco-themes 仅带 editor.background / foreground / selectionBackground 等极少数键
// （见 monaco-setup getEditorThemeColors）。故 muted 文字 / 各级背景 / 边框全部从 fg↔bg 混合派生，
// 并对次级文字加对比度地板（fadeWithFloor），防低对比主题（如 Solarized）击穿可读性。
//
// 取不到色 / 缺 bg·fg 时清空覆盖，回退到纯语义色板（仍随 data-theme 浅 / 深正常显示）。

import { getEditorThemeColors } from '../lib/monaco-setup';

/** 本模块覆盖的全部 CSS 自定义属性（清理时逐个 remove，回退到 _theme.scss 的语义色板）。 */
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

/** 解析 #rgb / #rgba / #rrggbb / #rrggbbaa；失败返回 null。 */
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

/** 在 c1 → c2 间按 t（0..1）线性插值（忽略 alpha，结果不透明）。 */
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

/** 相对亮度（WCAG）。 */
function luminance({ r, g, b }: Rgb): number {
  const ch = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** 对比度比值（WCAG，1..21）。 */
function contrastRatio(c1: Rgb, c2: Rgb): number {
  const l1 = luminance(c1);
  const l2 = luminance(c2);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 带对比度地板的「文字衰减」：本想把 fg 向 bg 混 desiredT（越大越淡），但从 desiredT 往 0 回收，
 * 直到结果对 bg 的对比度 ≥ floor 才停 —— 保证次级文字在低对比主题（如 Solarized）下不被衰减到不可读。
 * 代价是低对比主题里 muted 会塌回 ≈fg（与主文字同权重），是可读性优先的诚实取舍。
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
 * 把当前全局主题的 base 色派生为 GUI chrome 的结构性 token，写到 documentElement（覆盖 _theme.scss）。
 * 取不到色 / 缺 bg·fg 时清空覆盖、回退语义色板（仍随 data-theme 浅 / 深正常显示）。
 */
export function applyChromeFromEditorTheme(editorThemeId: string, resolvedGuiTheme: 'light' | 'dark'): void {
  // 'auto' 跟随解析主题 → 取默认 2026 主题（dark-2026 / light-2026）的 base 色
  const effectiveId =
    editorThemeId === 'auto' ? (resolvedGuiTheme === 'dark' ? 'dark-2026' : 'light-2026') : editorThemeId;
  const data = getEditorThemeColors(effectiveId);
  const bg = data && parseHex(data.colors['editor.background'] ?? '');
  const fg = data && parseHex(data.colors['editor.foreground'] ?? '');
  if (!bg || !fg) {
    clearChromeOverrides();
    console.warn('[chrome-sync] no usable bg/fg for theme, fell back to semantic palette:', effectiveId);
    return;
  }
  const isDark = luminance(bg) < 0.5;
  const edge = isDark ? WHITE : BLACK; // 提升层（背景越「浮」越靠该边）/ 边框混合方向
  const sel = parseHex(data?.colors['editor.selectionBackground'] ?? '') ?? mix(bg, edge, 0.16);

  // 各级背景：editor.background 为基准，按 elevation 轻微向 edge 提
  const bgPanel = mix(bg, edge, 0.03);
  const bgPanelAlt = mix(bg, edge, 0.06);
  const bgElev = mix(bg, edge, 0.05);
  const bgSurface = mix(bg, edge, 0.08);
  const bgHover = mix(bg, edge, 0.1);
  // 各级文字：editor.foreground 向 bg 衰减出 muted / subtle / dim，各带对比度地板防低对比主题击穿
  const textMuted = fadeWithFloor(fg, bg, 0.45, 4.5);
  const textSubtle = fadeWithFloor(fg, bg, 0.52, 4.0);
  const textDim = fadeWithFloor(fg, bg, 0.6, 3.0);
  // 边框：fg 大幅向 bg 衰减，留极淡轮廓
  const borderDefault = mix(fg, bg, 0.8);
  const borderMuted = mix(fg, bg, 0.88);
  const borderFade = { ...borderDefault, a: 0.5 };
  // 分组头：向黑轻微下沉（比 bg-app 略暗的「凹陷」标题带，hover 走 --bg-panel 上浮），随主题派生。
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

  // 可读性体检：muted 文字 / 弱边框对背景的对比度（AA 正文≥4.5、次要文本/非文本≥3）
  const mutedCr = contrastRatio(textMuted, bg);
  const borderCr = contrastRatio(borderDefault, bg);
  console.info(
    `[chrome-sync] "${effectiveId}" (${isDark ? 'dark' : 'light'}) → muted/bg contrast ${mutedCr.toFixed(2)} (AA≥4.5), border/bg ${borderCr.toFixed(2)} (≥3)`,
  );
}
