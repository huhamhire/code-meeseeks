/** 解析后的实际视觉主题（写入 data-theme 的值）。 */
export type ResolvedTheme = 'light' | 'dark';

/**
 * 全局主题（Monaco 编辑器 + 整个 GUI chrome 共用同一主题）的浅 / 深归属。
 * - `'light'` / `'dark'`：主题恒定浅 / 深。
 * - `'auto'`：跟随操作系统深 / 浅色（系统深色用 Dark Modern、浅色用 Light Modern）。
 */
export type EditorThemeMode = 'light' | 'dark' | 'auto';

/**
 * 全局主题选项（Monaco 配色主题，亦驱动整个 GUI chrome）。`id` 为生效的 Monaco 主题名，`label` 为展示名，
 * `mode` 为浅 / 深归属（决定 `data-theme` 与原生窗口 themeSource）。
 * - `'auto'`：特殊值，跟随系统深 / 浅色（深 → `vs-dark`、浅 → `vs`），默认。
 * - `vs` / `vs-dark` / `hc-light` / `hc-black`：Monaco 内置主题。
 * - 其余为内置注册的第三方主题（见 renderer monaco-setup，取色自 monaco-themes）。
 *
 * **label 不做 i18n**：主题为专有名（GitHub Dark / Monokai…），与语言 endonym 同理，各 UI 语言下
 * 展示一致、不翻译。**例外**：`'auto'` 非具体主题、而是「自动适应」模式，其展示文案走 i18n
 * （见 settings.editorThemeOptionAuto），本 label 仅作兜底。
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
  // Monaco 内置 vs / vs-dark 作为 Modern 默认（无需另引 VS Code Dark/Light Modern）。
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

/** 取主题的浅 / 深归属（未知 id 回落 `'auto'`）。 */
export function editorThemeMode(id: string): EditorThemeMode {
  return EDITOR_THEME_OPTIONS.find((o) => o.id === id)?.mode ?? 'auto';
}

/**
 * 把全局主题解析为实际视觉主题（写入 data-theme）。`'auto'` 主题按 `osPrefersDark` 落到深 / 浅。
 * main / renderer 共用：renderer 的 osPrefersDark 取 `prefers-color-scheme`，main 取 `nativeTheme`。
 */
export function resolveEditorThemeMode(id: string, osPrefersDark: boolean): ResolvedTheme {
  const mode = editorThemeMode(id);
  return mode === 'auto' ? (osPrefersDark ? 'dark' : 'light') : mode;
}

/**
 * 主题对应的原生窗口 themeSource：`'auto'` 交回 OS（`'system'`），其余固定浅 / 深。
 * 主进程据此设 `nativeTheme.themeSource`，让原生窗口 chrome（Windows 细边框 / 窗控按钮）跟随主题。
 */
export function editorThemeNativeSource(id: string): 'system' | 'light' | 'dark' {
  const mode = editorThemeMode(id);
  return mode === 'auto' ? 'system' : mode;
}

/** 受支持的编辑器主题 id 元组（供 zod enum 校验用）。 */
export const EDITOR_THEME_IDS = EDITOR_THEME_OPTIONS.map((o) => o.id) as [
  EditorTheme,
  ...EditorTheme[],
];

/** 编辑器字号合理范围（px）与默认值。下限保证可读、上限避免过大破坏布局；默认对齐历史 14px。 */
export const EDITOR_FONT_SIZE_MIN = 8;
export const EDITOR_FONT_SIZE_MAX = 32;
export const EDITOR_FONT_SIZE_DEFAULT = 14;

/** 设置页字号下拉的预设档位（仍受上面 min/max 约束；config 手改可取范围内任意整数）。 */
export const EDITOR_FONT_SIZE_PRESETS = [10, 11, 12, 13, 14, 15, 16, 18, 20, 24] as const;
