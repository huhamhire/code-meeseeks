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
 * 代码编辑器（Monaco）配色主题选项。
 * - `'auto'`：跟随 GUI 主题（浅色用 `vs`、深色用 `vs-dark`），默认。
 * - 其余为 Monaco 内置主题名：`vs`（浅）/ `vs-dark`（深）/ `hc-black`（高对比深）/ `hc-light`（高对比浅）。
 */
export const EDITOR_THEMES = ['auto', 'vs', 'vs-dark', 'hc-black', 'hc-light'] as const;
export type EditorTheme = (typeof EDITOR_THEMES)[number];
