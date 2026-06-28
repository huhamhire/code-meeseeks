import type { Platform } from '@meebox/shared';

/**
 * 把快捷键拆成**按键 token 数组**（一键一框、VS Code 风）：macOS 用符号（`⌥`/`⇧`/`⌘`/`B`），
 * 其余平台用文字（`Ctrl`/`Shift`/`Alt`/`B`）。仅用于命令面板右侧的提示展示；实际按键匹配在窗口级
 * 监听里另行判定（见 App 的快捷键 effect）。
 */
export function formatChord(
  platform: Platform,
  key: string,
  mods: { shift?: boolean; alt?: boolean } = {},
): string[] {
  const mac = platform === 'darwin';
  const tokens = mac
    ? [mods.alt && '⌥', mods.shift && '⇧', '⌘', key]
    : ['Ctrl', mods.shift && 'Shift', mods.alt && 'Alt', key];
  return tokens.filter((x): x is string => Boolean(x));
}
