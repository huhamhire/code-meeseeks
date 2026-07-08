import type { TFunction } from 'i18next';
import type { DiffChangedFile } from '@meebox/ipc';
import { invoke } from '../../../../../../api';

export const CASE_SENSITIVE_LS_KEY = 'meebox.diffSearch.caseSensitive';

/** Large-file guard: when a single file exceeds N matches, show only the first N + "more" */
export const PER_FILE_MATCH_CAP = 200;

export const SEARCH_DEBOUNCE_MS = 220;

/**
 * Search scope limit: scan only "changed lines + N lines of context above/below", aligned with the
 * "few lines of context around the diff" the user visually sees in the Monaco DiffEditor. N=10 is more
 * generous than git diff's default unified=3, letting search match references slightly farther from a
 * change (common case: changed a function's implementation, callers 5-10 lines above/below get found)
 */
const CONTEXT_LINES = 10;

export interface LineMatch {
  /** 1-based line number (line number on the srcSide side) */
  line: number;
  content: string;
  /** The line's role in the diff */
  diffRole: 'added' | 'removed' | 'context';
  /** Whether the line belongs to the head or base file — decides onJumpToMatch's side param */
  srcSide: 'old' | 'new';
  /** Start/end position of the matched substring within content (used for highlight rendering) */
  matchStart: number;
  matchEnd: number;
  /**
   * HTML after Monaco colorize (with inline-style syntax coloring). Undefined when the first wave of results
   * returns; filled in asynchronously after background colorize completes, then the UI updates once more.
   * When uncolorized, falls back to renderHighlight using plain text + keyword `<mark>`
   */
  colorizedHtml?: string;
}

export interface FileResults {
  file: DiffChangedFile;
  matches: LineMatch[];
}

export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}
export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '' : p.slice(0, i);
}

/**
 * Cross-file search main logic:
 *
 * For each file:
 *   1. Fetch head + base content (skip IPC on cache hit)
 *   2. Compute the "changed lines" set via multiset consume, expand ±CONTEXT_LINES to get the "visible range"
 *      (aligned with the hunk-surrounding context the user sees in the Diff view)
 *   3. Scan line-by-line for matches only within the visible range
 *   4. head match: base side also has it → context; otherwise added
 *   5. base match with none on the head side: removed (excluding those already matched as context)
 *   6. Sort a file's results in ascending line order
 *
 * A single file failing (binary / fetch error) is silently skipped; finally returns partialError noting how many
 * files failed to search
 */
export async function runSearch(
  token: number,
  rawQuery: string,
  caseSensitive: boolean,
  files: DiffChangedFile[],
  prLocalId: string,
  cache: Map<string, string | null>,
  t: TFunction,
): Promise<{ results: FileResults[]; partialError: string | null }> {
  const out: FileResults[] = [];
  let failedCount = 0;
  const probe = caseSensitive ? rawQuery : rawQuery.toLowerCase();

  await Promise.all(
    files.map(async (f) => {
      try {
        const headPath = f.path;
        const basePath = f.oldPath ?? f.path;
        const [headText, baseText] = await Promise.all([
          loadContent(cache, prLocalId, 'head', headPath),
          loadContent(cache, prLocalId, 'base', basePath),
        ]);
        // User switched to another query midway — this promise was cancelled before returning, so bail
        if (token === -1) return;

        const headLines = headText === null ? [] : headText.split('\n');
        const baseLines = baseText === null ? [] : baseText.split('\n');
        // Use a Multiset rather than a Set — a same-content line may appear multiple times (blank line / brace / same-named
        // variable declaration). A Set would misjudge "some instance still exists on the base side" as context and skip added
        const baseLineCount = countLines(baseLines);
        const headLineCount = countLines(headLines);

        // Changed-line set + ±CONTEXT_LINES context = the range the user sees in the Diff view
        const changedHead = findChangedIndices(headLines, baseLineCount);
        const changedBase = findChangedIndices(baseLines, headLineCount);
        const visibleHead = expandToContext(changedHead, headLines.length);
        const visibleBase = expandToContext(changedBase, baseLines.length);

        const matches: LineMatch[] = [];
        // scan the head side
        for (let i = 0; i < headLines.length; i++) {
          if (!visibleHead.has(i)) continue;
          const line = headLines[i]!;
          const span = findMatchSpan(line, rawQuery, caseSensitive, probe);
          if (span === null) continue;
          // base side has the same content → context; otherwise added
          const stillInBase = (baseLineCount.get(line) ?? 0) > 0;
          const stripped = stripLeadingIndent(line, span);
          matches.push({
            line: i + 1,
            content: stripped.content,
            diffRole: stillInBase ? 'context' : 'added',
            srcSide: 'new',
            matchStart: stripped.matchStart,
            matchEnd: stripped.matchEnd,
          });
        }
        // scan the base side, collecting only removed lines that "appear only in base" (to avoid duplicating context)
        for (let i = 0; i < baseLines.length; i++) {
          if (!visibleBase.has(i)) continue;
          const line = baseLines[i]!;
          const span = findMatchSpan(line, rawQuery, caseSensitive, probe);
          if (span === null) continue;
          if ((headLineCount.get(line) ?? 0) > 0) continue;
          const stripped = stripLeadingIndent(line, span);
          matches.push({
            line: i + 1,
            content: stripped.content,
            diffRole: 'removed',
            srcSide: 'old',
            matchStart: stripped.matchStart,
            matchEnd: stripped.matchEnd,
          });
        }
        if (matches.length === 0) return;
        // Sort: first by srcSide (head first) then by line, giving the result list a predictable order
        matches.sort((a, b) => {
          if (a.srcSide !== b.srcSide) return a.srcSide === 'new' ? -1 : 1;
          return a.line - b.line;
        });
        out.push({ file: f, matches });
      } catch {
        failedCount++;
      }
    }),
  );

  // File-level sort by path lexicographic order, aligned with the file tree visually
  out.sort((a, b) => a.file.path.localeCompare(b.file.path));
  return {
    results: out,
    partialError:
      failedCount > 0 ? t('diffSearchPanel.partialError', { count: failedCount }) : null,
  };
}

/**
 * Compute the "changed lines" line-number set via multiset consume: if the other side has a same-content line, pair
 * and consume it (decrement 1 from the count table); those that can't be paired "appear only on this side" — i.e. changed lines.
 *
 * More accurate than a simple set contains / doesn't-contain check — same-content lines (blank line / `}` / same-named
 * import) in a PR are generally matches that exist, not changes
 */
export function findChangedIndices(
  ownLines: string[],
  otherCount: Map<string, number>,
): Set<number> {
  const remaining = new Map(otherCount);
  const changed = new Set<number>();
  for (let i = 0; i < ownLines.length; i++) {
    const l = ownLines[i]!;
    const c = remaining.get(l) ?? 0;
    if (c > 0) remaining.set(l, c - 1);
    else changed.add(i);
  }
  return changed;
}

/** Expand the changed-line index set by ±CONTEXT_LINES and merge adjacent ranges */
export function expandToContext(changed: Set<number>, total: number): Set<number> {
  const out = new Set<number>();
  for (const idx of changed) {
    const lo = Math.max(0, idx - CONTEXT_LINES);
    const hi = Math.min(total - 1, idx + CONTEXT_LINES);
    for (let j = lo; j <= hi; j++) out.add(j);
  }
  return out;
}

export async function loadContent(
  cache: Map<string, string | null>,
  prLocalId: string,
  side: 'head' | 'base',
  path: string,
): Promise<string | null> {
  const k = `${side}:${path}`;
  if (cache.has(k)) return cache.get(k)!;
  try {
    const c = await invoke('diff:getFileContent', {
      localId: prLocalId,
      side,
      path,
    });
    // DiffFileContent union: {binary:false, content:string} or {binary:true} (the latter incl. Git LFS pointers).
    // binary / LFS files skip search (no comparable text); only non-binary takes the content field
    const text = c.binary === false ? c.content : null;
    cache.set(k, text);
    return text;
  } catch {
    cache.set(k, null);
    return null;
  }
}

/**
 * Strip leading indent (tab / space) — the search panel has limited width; keeping the code's original indent
 * wastes horizontal space and makes the match look inconspicuous. After stripping it's visually left-aligned, and
 * the keyword highlight start/end are recomputed against the stripped content. If the match is **inside** the
 * indent (query contains leading whitespace) → don't strip, to keep the highlight position correct
 */
export function stripLeadingIndent(
  line: string,
  span: [number, number],
): { content: string; matchStart: number; matchEnd: number } {
  const m = /^[\t ]+/.exec(line);
  if (!m) return { content: line, matchStart: span[0], matchEnd: span[1] };
  const offset = m[0].length;
  if (span[0] < offset) {
    // Match is in the indent region; stripping would misalign the highlight — keep the original content
    return { content: line, matchStart: span[0], matchEnd: span[1] };
  }
  return {
    content: line.slice(offset),
    matchStart: span[0] - offset,
    matchEnd: span[1] - offset,
  };
}

export function countLines(lines: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
}

export function findMatchSpan(
  line: string,
  query: string,
  caseSensitive: boolean,
  probeLower: string,
): [number, number] | null {
  if (caseSensitive) {
    const idx = line.indexOf(query);
    return idx < 0 ? null : [idx, idx + query.length];
  }
  const idx = line.toLowerCase().indexOf(probeLower);
  return idx < 0 ? null : [idx, idx + query.length];
}
