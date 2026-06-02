/**
 * 把含 ANSI SGR 转义的字符串切成可渲染的 segment 列表。
 *
 * 底层用 [anser](https://github.com/IonicaBizau/anser)（事实标准 ANSI → JSON 解析器，
 * 7KB 体积，Sentry / Storybook / Jest 都在用）。它正确处理 SGR / OSC / CSI 全谱、
 * 16/256/truecolor、bold/italic/underline/dim 装饰，不踩自卷边角案的坑（之前自实现
 * 时撞过 `\x1b.` 贪心吃掉 CSI 起头的 bug）。
 *
 * Anser 返回的 fg / bg 是 `"rgb(r, g, b)"` 字符串 (默认配色为标准 ANSI 16 色 + 256
 * 色 cube 算法)，直接塞进 React style 即可。
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

/** AnsiSegment → React inline style；给 <span style={...}> 用 */
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
