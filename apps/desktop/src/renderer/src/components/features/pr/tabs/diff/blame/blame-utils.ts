import type { DiffBlameLine } from '@meebox/ipc';

/** Bitbucket 风格 blame 列宽：头像(20) + name(80) + sha(75) + date(45) + padding */
export const BLAME_COLUMN_WIDTH = 240;

export interface BlameLayout {
  /** Monaco modified editor 可视高度 (px) */
  viewportHeight: number;
  /** Monaco 当前行高 (px) */
  lineHeight: number;
  /** Monaco 当前垂直滚动 (px) */
  scrollTop: number;
}

export interface BlameBlock {
  commit: string;
  author: string;
  authorEmail: string;
  authorDate: string;
  summary: string;
  lineFrom: number;
  lineTo: number;
}

export function formatIsoDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 把行号列表合并为连续区段 [from, to]，便于画色带（减少 DOM 节点） */
export function mergeContiguousLines(lines: number[]): Array<[number, number]> {
  if (lines.length === 0) return [];
  const sorted = [...lines].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  let from = sorted[0]!;
  let to = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i]!;
    if (n === to + 1) {
      to = n;
    } else {
      out.push([from, to]);
      from = n;
      to = n;
    }
  }
  out.push([from, to]);
  return out;
}

/** 合并连续同 commit 的 blame 行为区块（Bitbucket 风格：一个 commit 一格） */
export function groupBlameByCommit(blame: DiffBlameLine[]): BlameBlock[] {
  const sorted = [...blame].sort((a, b) => a.line - b.line);
  const blocks: BlameBlock[] = [];
  let cur: BlameBlock | null = null;
  for (const b of sorted) {
    if (cur && cur.commit === b.commit && cur.lineTo === b.line - 1) {
      cur.lineTo = b.line;
    } else {
      cur = {
        commit: b.commit,
        author: b.author,
        authorEmail: b.authorEmail,
        authorDate: b.authorDate,
        summary: b.summary,
        lineFrom: b.line,
        lineTo: b.line,
      };
      blocks.push(cur);
    }
  }
  return blocks;
}
