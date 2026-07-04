import type { DiffBlameLine } from '@meebox/ipc';

/** Bitbucket-style blame column width: avatar(20) + name(80) + sha(75) + date(45) + padding */
export const BLAME_COLUMN_WIDTH = 240;

export interface BlameLayout {
  /** Monaco modified editor visible height (px) */
  viewportHeight: number;
  /** Monaco current line height (px) */
  lineHeight: number;
  /** Monaco current vertical scroll (px) */
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

/** Merge a list of line numbers into contiguous ranges [from, to] to ease drawing color bands (reduces DOM nodes) */
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

/** Merge contiguous blame lines of the same commit into blocks (Bitbucket-style: one cell per commit) */
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
