import { useEffect, useSyncExternalStore } from 'react';
import type { ResolvedTheme, ThemePreference } from '@meebox/shared';
import { applyThemePreference, persistThemePreference, watchSystemTheme } from '../theme';

/**
 * 跟随主题偏好生效：偏好变化时把它解析后写到 documentElement.data-theme + 持久化到 localStorage
 * （供下次启动同步命中）；'system' 偏好下还监听 OS 深 / 浅色切换、实时重解析跟随。
 *
 * 偏好源为 config.appearance.theme（启动 boot.config 注入，设置页即时改动经 patchConfig 同步），
 * 故主题切换与语言切换走同一条「config 驱动 + 即时生效」路径。
 */
export function useTheme(preference: ThemePreference): void {
  useEffect(() => {
    applyThemePreference(preference);
    persistThemePreference(preference);
    return watchSystemTheme(preference);
  }, [preference]);
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
