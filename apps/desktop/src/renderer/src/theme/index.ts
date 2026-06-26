import { resolveEditorThemeMode, editorThemeMode, type ResolvedTheme } from '@meebox/shared';

/**
 * 渲染层主题运行时。
 *
 * 全局主题（Monaco 编辑器 + 整个 GUI chrome 共用同一主题，见 @meebox/shared EDITOR_THEME_OPTIONS）反推
 * 浅 / 深，写到 `documentElement` 的 `data-theme`；语义配色经 CSS 自定义属性整体切换（默认 :root = 暗色，
 * `[data-theme='light']` 覆盖为浅色，见 styles/_theme.scss）。结构性 chrome 色另由主题派生覆盖（见
 * editor-chrome-sync）。本模块只管 data-theme + 字体，不引 Monaco（保持首帧轻量）。
 *
 * - 主题经 IPC 异步到达（config.appearance.editor_theme），启动时拿不到；localStorage 可同步读，故用它做
 *   首帧初始主题，避免启动闪错主题。App 拿到 config 后会 persist 回写，下次启动直接命中。
 * - 主题 mode 为 'auto' 时跟随 `prefers-color-scheme`，并由 watchSystemThemeForAuto 在 OS 切换时实时重解析。
 * - 默认主题取 **auto**（自动适应系统）：localStorage 无记录 / 不可用时回落 'auto'。
 */

const EDITOR_THEME_STORAGE_KEY = 'meebox.editorTheme';
const DEFAULT_EDITOR_THEME = 'auto';

/** OS 是否偏好深色（'auto' 主题据此解析）。matchMedia 不可用时保守按深色。 */
function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
}

/** 把全局主题 id 解析为实际视觉主题（'auto' 按 OS 深 / 浅落地）。 */
export function resolveGlobalTheme(editorTheme: string): ResolvedTheme {
  return resolveEditorThemeMode(editorTheme, systemPrefersDark());
}

/** 读 localStorage 缓存的主题作首帧初始值；无记录 / 不可用时回落默认（auto）。 */
export function readInitialEditorTheme(): string {
  try {
    return localStorage.getItem(EDITOR_THEME_STORAGE_KEY) ?? DEFAULT_EDITOR_THEME;
  } catch {
    return DEFAULT_EDITOR_THEME;
  }
}

/** 持久化主题到 localStorage，供下次启动同步读取作初始主题。 */
export function persistEditorTheme(editorTheme: string): void {
  try {
    localStorage.setItem(EDITOR_THEME_STORAGE_KEY, editorTheme);
  } catch {
    // localStorage 不可用时忽略：仅影响下次启动的初始主题命中，不影响功能。
  }
}

/** 把全局主题反推浅 / 深后写到 documentElement.data-theme，触发语义色板整体切换。 */
export function applyGlobalTheme(editorTheme: string): void {
  document.documentElement.dataset.theme = resolveGlobalTheme(editorTheme);
}

/**
 * 监听 OS 深 / 浅色变化。仅 'auto' 主题需要：OS 切换时实时重解析并重写 data-theme。
 * 返回取消订阅函数；非 'auto' 主题直接返回空 cleanup（无监听）。
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

// 内置等宽字体兜底栈：用户自定义字体后置于其后，保证缺字时仍回落到合理 mono 字体。
const MONO_FALLBACK = "'Cascadia Code', 'Consolas', ui-monospace, monospace";

/** 把用户配置的字体族解析为完整 font-family 串（追加兜底栈）；空配置返回 undefined（用默认）。 */
export function resolveEditorFontFamily(font: string): string | undefined {
  const f = font.trim();
  return f ? `${f}, ${MONO_FALLBACK}` : undefined;
}

/**
 * 应用编辑器等宽字体到全应用：写 documentElement 的 `--editor-font-family` 自定义属性（$font-mono 经
 * 它取值，覆盖 diff / 评论 / 代码块等所有等宽文本）。空配置时移除该属性，回落内置 mono 字体栈。
 * Monaco 编辑器内容字体另经其 fontFamily option 设置（见 DiffPane / InlineCodeContext）。
 */
export function applyEditorFontFamily(font: string): void {
  const resolved = resolveEditorFontFamily(font);
  if (resolved) document.documentElement.style.setProperty('--editor-font-family', resolved);
  else document.documentElement.style.removeProperty('--editor-font-family');
}

// 副作用：模块导入即按 localStorage 缓存定下首帧主题（在 React 渲染前），避免启动闪错主题。
applyGlobalTheme(readInitialEditorTheme());
