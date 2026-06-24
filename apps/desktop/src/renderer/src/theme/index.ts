import {
  matchThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from '@meebox/shared';

/**
 * 渲染层主题运行时。
 *
 * 主题偏好（system / light / dark）解析为实际视觉主题（light / dark），写到 `documentElement`
 * 的 `data-theme`；配色经 CSS 自定义属性整体切换（默认 :root = 暗色，`[data-theme='light']`
 * 覆盖为浅色，见 styles/_theme.scss）。
 *
 * - 偏好经 IPC 异步到达（config.appearance.theme），启动时拿不到；localStorage 可同步读，故用它做
 *   首帧初始主题，避免浅色用户启动先闪一帧深色。App 拿到 config 后会 persist 回写，下次启动直接命中。
 * - 偏好为 'system' 时跟随 `prefers-color-scheme`，并由 watchSystemTheme 在 OS 切换时实时重解析。
 * - 默认偏好取 **dark**（与历史一致）：localStorage 无记录、解析失败时回落深色。
 */

const THEME_STORAGE_KEY = 'meebox.theme';
const DEFAULT_PREFERENCE: ThemePreference = 'dark';

/** OS 是否偏好深色（'system' 偏好据此解析）。matchMedia 不可用时保守按深色。 */
function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
}

/** 把主题偏好解析为实际视觉主题。 */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return preference;
}

/** 读 localStorage 缓存的偏好作首帧初始值；无记录 / 不可用时回落默认（dark）。 */
export function readInitialThemePreference(): ThemePreference {
  try {
    return matchThemePreference(localStorage.getItem(THEME_STORAGE_KEY)) ?? DEFAULT_PREFERENCE;
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

/** 持久化偏好到 localStorage，供下次启动同步读取作初始主题。 */
export function persistThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // localStorage 不可用时忽略：仅影响下次启动的初始主题命中，不影响功能。
  }
}

/** 把偏好解析后写到 documentElement.data-theme，触发 CSS 自定义属性整体切换。 */
export function applyThemePreference(preference: ThemePreference): void {
  document.documentElement.dataset.theme = resolveTheme(preference);
}

/**
 * 监听 OS 深 / 浅色变化。仅 'system' 偏好需要：OS 切换时实时重解析并重写 data-theme。
 * 返回取消订阅函数；非 'system' 偏好直接返回空 cleanup（无监听）。
 */
export function watchSystemTheme(preference: ThemePreference): () => void {
  if (preference !== 'system') return () => {};
  let mq: MediaQueryList;
  try {
    mq = window.matchMedia('(prefers-color-scheme: dark)');
  } catch {
    return () => {};
  }
  const onChange = (): void => applyThemePreference('system');
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
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

// 副作用：模块导入即按 localStorage 缓存定下首帧主题（在 React 渲染前），避免浅色用户启动闪深色。
applyThemePreference(readInitialThemePreference());
