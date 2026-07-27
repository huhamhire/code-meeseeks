import type { Platform } from '@meebox/shared';

/**
 * Split a shortcut into a **key token array** (one box per key, VS Code style): macOS uses symbols (`⌥`/`⇧`/`⌘`/`B`),
 * other platforms use text (`Ctrl`/`Shift`/`Alt`/`B`). Only for the hint display on the right side of the command palette; the actual key matching
 * is judged separately in the window-level listener (see App's shortcut effect).
 */
export function formatChord(
  platform: Platform,
  key: string,
  mods: { shift?: boolean; alt?: boolean; ctrl?: boolean } = {},
): string[] {
  const mac = platform === 'darwin';
  // Primary modifier: normally ⌘ (mac) / Ctrl (other). With `ctrl`, force the literal Control key on both — mac shows ⌃
  // instead of ⌘ — for bindings that match `e.ctrlKey` on every platform (e.g. Ctrl+F5, where ⌘F5 would hit macOS VoiceOver).
  const primary = mac ? (mods.ctrl ? '⌃' : '⌘') : 'Ctrl';
  const tokens = mac
    ? [mods.alt && '⌥', mods.shift && '⇧', primary, key]
    : [primary, mods.shift && 'Shift', mods.alt && 'Alt', key];
  return tokens.filter((x): x is string => Boolean(x));
}
