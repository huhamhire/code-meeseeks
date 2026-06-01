/**
 * 把含 ANSI SGR 转义的字符串切成可渲染的 segment 列表。
 *
 * 解析仅覆盖 pr-agent / 一般 CLI 输出最常用的 SGR 子集：
 *   - 0  : reset
 *   - 1  : bold      / 22 取消
 *   - 2  : dim       / 22 取消
 *   - 3  : italic    / 23 取消
 *   - 4  : underline / 24 取消
 *   - 30-37   / 39 reset : 8 种标准前景
 *   - 40-47   / 49 reset : 8 种标准背景
 *   - 90-97              : bright 前景
 *   - 100-107            : bright 背景
 *   - 38;5;n  / 48;5;n   : 256 色 (按表查 fg/bg；不在表内的退到默认色，状态机会跳过参数)
 *   - 38;2;R;G;B / 48;2;R;G;B : truecolor (直接产 #rrggbb)
 *
 * 其他控制序列 (光标移动、清屏、OSC 标题等) 一律剥离不渲染。
 */

export interface AnsiSegment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
}

// VS Code Dark+ 主题的 ANSI 16 色调色板 (跟 integratedTerminal 一致)
const FG_16 = [
  '#cccccc', // 30 black → 在暗色 UI 上反转成浅灰，避免不可见
  '#cd3131', // 31 red
  '#0dbc79', // 32 green
  '#e5e510', // 33 yellow
  '#2472c8', // 34 blue
  '#bc3fbc', // 35 magenta
  '#11a8cd', // 36 cyan
  '#e5e5e5', // 37 white
];
const FG_16_BRIGHT = [
  '#666666',
  '#f14c4c',
  '#23d18b',
  '#f5f543',
  '#3b8eea',
  '#d670d6',
  '#29b8db',
  '#ffffff',
];
const BG_16 = [
  '#000000',
  '#cd3131',
  '#0dbc79',
  '#e5e510',
  '#2472c8',
  '#bc3fbc',
  '#11a8cd',
  '#e5e5e5',
];
const BG_16_BRIGHT = FG_16_BRIGHT;

// 匹配 CSI SGR 序列：ESC [ <params> m。\x1b / \x07 是 ANSI 标准里的控制字符，
// 这里就是要识别它们；eslint no-control-regex 在此场景下是误报，行级关掉
// eslint-disable-next-line no-control-regex
const CSI_SGR_RE = /\x1b\[([\d;]*)m/g;
// 匹配其他需要剥离但不应用样式的控制序列（CSI 非 m 结尾 + OSC ]...BEL/ST + 单字节控制）
// eslint-disable-next-line no-control-regex
const OTHER_ESC_RE = /\x1b\[[\d;]*[a-ln-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g;

interface StyleState {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
}

function emptyState(): StyleState {
  return {};
}

/**
 * 256 色立方体 → 近似 RGB。0-15 走 16 色标准；16-231 是 6x6x6 RGB cube；
 * 232-255 是灰阶。从 xterm 标准映射，跟 VS Code Terminal 显示一致。
 */
function ansi256ToHex(n: number): string {
  if (n < 0 || n > 255) return '';
  if (n < 8) return FG_16[n]!;
  if (n < 16) return FG_16_BRIGHT[n - 8]!;
  if (n < 232) {
    const i = n - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const v = (x: number): number => (x === 0 ? 0 : 55 + x * 40);
    return `#${[v(r), v(g), v(b)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  }
  const g = 8 + (n - 232) * 10;
  return `#${[g, g, g].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

function applySgr(state: StyleState, codes: number[]): StyleState {
  let s = { ...state };
  let i = 0;
  while (i < codes.length) {
    const c = codes[i]!;
    if (c === 0) s = emptyState();
    else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 3) s.italic = true;
    else if (c === 4) s.underline = true;
    else if (c === 22) {
      s.bold = undefined;
      s.dim = undefined;
    } else if (c === 23) s.italic = undefined;
    else if (c === 24) s.underline = undefined;
    else if (c >= 30 && c <= 37) s.fg = FG_16[c - 30];
    else if (c === 39) s.fg = undefined;
    else if (c >= 40 && c <= 47) s.bg = BG_16[c - 40];
    else if (c === 49) s.bg = undefined;
    else if (c >= 90 && c <= 97) s.fg = FG_16_BRIGHT[c - 90];
    else if (c >= 100 && c <= 107) s.bg = BG_16_BRIGHT[c - 100];
    else if (c === 38 || c === 48) {
      const mode = codes[i + 1];
      if (mode === 5 && codes.length >= i + 3) {
        const color = ansi256ToHex(codes[i + 2]!);
        if (c === 38) s.fg = color;
        else s.bg = color;
        i += 2;
      } else if (mode === 2 && codes.length >= i + 5) {
        const [r, g, b] = [codes[i + 2]!, codes[i + 3]!, codes[i + 4]!];
        const hex = `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
        if (c === 38) s.fg = hex;
        else s.bg = hex;
        i += 4;
      }
    }
    // 其他 SGR (闪烁 / 反显 / 加密等) 忽略
    i++;
  }
  return s;
}

export function parseAnsi(input: string): AnsiSegment[] {
  // 先把非 SGR 的转义序列 (光标控制 / OSC / ...) 剥掉，避免破坏文本
  const cleaned = input.replace(OTHER_ESC_RE, '');
  const out: AnsiSegment[] = [];
  let state = emptyState();
  let last = 0;
  let m: RegExpExecArray | null;
  CSI_SGR_RE.lastIndex = 0;
  while ((m = CSI_SGR_RE.exec(cleaned)) !== null) {
    if (m.index > last) {
      out.push({ ...state, text: cleaned.slice(last, m.index) });
    }
    const codes = m[1] ? m[1].split(';').map((s) => Number(s) || 0) : [0];
    state = applySgr(state, codes);
    last = CSI_SGR_RE.lastIndex;
  }
  if (last < cleaned.length) {
    out.push({ ...state, text: cleaned.slice(last) });
  }
  return out.filter((s) => s.text.length > 0);
}

/** 把 AnsiSegment 翻成 React style 对象，给 <span style={...}> 用 */
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
