// On macOS Monaco's font size looks visually larger than on Windows (system font rendering differences); the same
// px value looks bigger on mac. Uniformly shrink the editor font size by one on mac to bring both platforms closer.
export const IS_MAC = navigator.platform.toLowerCase().includes('mac');

/** Correct Monaco font size per platform: mac minus 1px, original value on other platforms. */
export function editorFontSize(base: number): number {
  return IS_MAC ? base - 1 : base;
}
