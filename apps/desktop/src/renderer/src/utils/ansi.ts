/**
 * Slice a string containing ANSI SGR escapes into a renderable segment list.
 *
 * Backed by [anser](https://github.com/IonicaBizau/anser) (de-facto standard ANSI → JSON parser,
 * 7KB, used by Sentry / Storybook / Jest). It correctly handles the full SGR / OSC / CSI spectrum,
 * 16/256/truecolor, bold/italic/underline/dim decorations, and avoids the pitfalls of a hand-rolled
 * edge case (a prior self-implementation hit a `\x1b.` greedy bug that ate the CSI head).
 *
 * Anser returns fg / bg as `"rgb(r, g, b)"` strings (default palette is standard ANSI 16 colors + 256
 * color cube algorithm), which can be dropped straight into a React style.
 */

import Anser from 'anser';

export interface AnsiSegment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
}

export function parseAnsi(input: string): AnsiSegment[] {
  const tokens = Anser.ansiToJson(input, { json: true, remove_empty: true });
  return tokens
    .filter((t) => !t.isEmpty())
    .map<AnsiSegment>((t) => {
      const decorations = new Set(t.decorations);
      return {
        text: t.content,
        fg: t.fg ? `rgb(${t.fg})` : undefined,
        bg: t.bg ? `rgb(${t.bg})` : undefined,
        bold: decorations.has('bold'),
        italic: decorations.has('italic'),
        underline: decorations.has('underline'),
        dim: decorations.has('dim'),
      };
    });
}

/** AnsiSegment → React inline style; for use with <span style={...}> */
export function segmentStyle(seg: AnsiSegment): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (seg.fg) style.color = seg.fg;
  if (seg.bg) style.backgroundColor = seg.bg;
  if (seg.bold) style.fontWeight = 600;
  if (seg.italic) style.fontStyle = 'italic';
  if (seg.underline) style.textDecoration = 'underline';
  if (seg.dim) style.opacity = 0.7;
  return style;
}
