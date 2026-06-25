/**
 * GUI 主题偏好（main / renderer 共用类型）。
 *
 * - `'system'`：跟随操作系统深色 / 浅色偏好（renderer 经 `prefers-color-scheme` 解析，OS 切换实时跟随）。
 * - `'light'` / `'dark'`：固定浅色 / 深色，忽略 OS。
 *
 * 实际生效的视觉主题（深 / 浅）由 renderer 把偏好解析后写到 `documentElement` 的 `data-theme`，
 * 配色经 CSS 自定义属性整体切换（见 styles/_theme.scss）。主题为纯前端展示项，主进程不消费。
 */
export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** 解析后的实际视觉主题（写入 data-theme 的值）。 */
export type ResolvedTheme = 'light' | 'dark';

/** 把任意串规整为受支持的主题偏好，无法识别返回 null。 */
export function matchThemePreference(value: string | null | undefined): ThemePreference | null {
  return (THEME_PREFERENCES as readonly string[]).includes(value ?? '')
    ? (value as ThemePreference)
    : null;
}

/**
 * 代码编辑器（Monaco）配色主题选项。`id` 为生效的 Monaco 主题名，`label` 为展示名。
 * - `'auto'`：特殊值，跟随 GUI 主题（浅色用 `vs`、深色用 `vs-dark`），默认。
 * - `vs` / `vs-dark` / `hc-light` / `hc-black`：Monaco 内置主题。
 * - 其余为内置注册的第三方主题（见 renderer monaco-setup，取色自 monaco-themes）。
 *
 * **label 不做 i18n**：主题为专有名（GitHub Dark / Monokai…），与语言 endonym 同理，各 UI 语言下
 * 展示一致、不翻译。**例外**：`'auto'` 非具体主题、而是「跟随应用」模式，其展示文案走 i18n
 * （见 settings.editorThemeOptionAuto），本 label 仅作兜底。
 */
export interface EditorThemeOption {
  id: string;
  label: string;
}

export const EDITOR_THEME_OPTIONS = [
  { id: 'auto', label: 'Auto' },
  { id: 'vs', label: 'Light' },
  { id: 'vs-dark', label: 'Dark' },
  { id: 'hc-light', label: 'High Contrast Light' },
  { id: 'hc-black', label: 'High Contrast Dark' },
  { id: 'github-light', label: 'GitHub Light' },
  { id: 'github-dark', label: 'GitHub Dark' },
  { id: 'monokai', label: 'Monokai' },
  { id: 'dracula', label: 'Dracula' },
  { id: 'nord', label: 'Nord' },
  { id: 'night-owl', label: 'Night Owl' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'tomorrow-night', label: 'Tomorrow Night' },
  { id: 'solarized-light', label: 'Solarized Light' },
  { id: 'solarized-dark', label: 'Solarized Dark' },
  { id: 'cobalt2', label: 'Cobalt2' },
  { id: 'oceanic-next', label: 'Oceanic Next' },
] as const satisfies readonly EditorThemeOption[];

export type EditorTheme = (typeof EDITOR_THEME_OPTIONS)[number]['id'];

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
