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

/**
 * 全局主题生效：主题变化时把它反推浅 / 深写到 documentElement.data-theme（驱动语义色板）+ 派生结构性
 * chrome 色覆盖 + 持久化到 localStorage（供下次启动同步命中）；'auto' 主题下还监听 OS 深 / 浅色切换、
 * 实时重解析跟随。
 *
 * 主题源为共享 store（由 useEditorAppearanceSync 从 config.appearance.editor_theme 注入，设置页即时
 * 改动经 setEditorAppearance 同步），故主题切换与语言切换走同一条「config 驱动 + 即时生效」路径。
 */
export function useGlobalTheme(): void {
  const { editorTheme } = useEditorAppearance();
  useEffect(() => {
    applyGlobalTheme(editorTheme);
    persistEditorTheme(editorTheme);
    applyChromeFromEditorTheme(editorTheme, resolveGlobalTheme(editorTheme));
    // 'auto' 主题：OS 深浅切换时重写 data-theme（watch 内部已做）并重派生 chrome
    return watchSystemThemeForAuto(editorTheme, () => {
      applyChromeFromEditorTheme(editorTheme, resolveGlobalTheme(editorTheme));
    });
  }, [editorTheme]);
}

/** 订阅 documentElement.data-theme 变化（含 system 偏好下 OS 切换）。 */
function subscribeResolvedTheme(onChange: () => void): () => void {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => obs.disconnect();
}

function getResolvedThemeSnapshot(): ResolvedTheme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/**
 * 当前实际生效的视觉主题（解析后的 light / dark），随 data-theme 变化实时更新。供需按主题切换内部
 * 配色的非 CSS 组件用（如 Monaco 编辑器、Mermaid —— 它们的主题不走 CSS 自定义属性，须显式传入）。
 */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeResolvedTheme, getResolvedThemeSnapshot);
}

/**
 * 把 config.appearance 的编辑器外观同步到运行时：写入共享 store（供 Monaco 组件读）+ 应用等宽字体
 * CSS 变量（供全应用 $font-mono）。源为 config（启动注入、设置页即时改动经 patchConfig 同步）。
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
 * 当前生效的 Monaco 编辑器主题名：编辑器主题偏好为 'auto' 时跟随 GUI 解析主题（浅 'vs' / 深 'vs-dark'），
 * 否则用所选 Monaco 内置主题（vs / vs-dark / hc-black / hc-light）。
 */
export function useMonacoEditorTheme(): string {
  const { editorTheme } = useEditorAppearance();
  const resolved = useResolvedTheme();
  if (editorTheme === 'auto') return resolved === 'light' ? 'vs' : 'vs-dark';
  return editorTheme;
}
