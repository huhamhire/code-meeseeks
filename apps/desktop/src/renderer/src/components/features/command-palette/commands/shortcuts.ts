import type { Platform } from '@meebox/shared';

/**
 * Split a shortcut into a **key token array** (one box per key, VS Code style): macOS uses symbols (`⌥`/`⇧`/`⌘`/`B`),
 * other platforms use text (`Ctrl`/`Shift`/`Alt`/`B`). Only for the hint display on the right side of the command palette; the actual key matching
 * is judged separately in the window-level listener (see App's shortcut effect).
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
