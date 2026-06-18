// macOS 下 Monaco 的字号视觉上比 Windows 偏大（系统字体渲染差异），同样的 px 值在 mac
// 看着更大。统一在 mac 上把编辑器字号缩小一号，让两端体验接近。
export const IS_MAC = navigator.platform.toLowerCase().includes('mac');

/** 按平台校正 Monaco 字号：mac 减 1px，其他平台原值。 */
export function editorFontSize(base: number): number {
  return IS_MAC ? base - 1 : base;
}
