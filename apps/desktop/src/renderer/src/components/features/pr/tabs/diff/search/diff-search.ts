import type { TFunction } from 'i18next';
import type { DiffChangedFile } from '@meebox/ipc';
import { invoke } from '../../../../../../api';

export const CASE_SENSITIVE_LS_KEY = 'meebox.diffSearch.caseSensitive';

/** 大文件保护：单文件超过 N 条命中只展示前 N + "更多" */
export const PER_FILE_MATCH_CAP = 200;

export const SEARCH_DEBOUNCE_MS = 220;

/**
 * 搜索范围限制：仅扫"变更行 + 上下 N 行 context"，跟 Monaco DiffEditor 视觉上
 * 用户能看到的"diff 周围若干行 context"对齐。N=10 比 git diff 默认 unified=3
 * 更宽松，让搜索能命中变更附近稍远的引用 (常见场景：改了某个函数实现，调用方
 * 在其上下 5-10 行能被搜到)
 */
const CONTEXT_LINES = 10;

export interface LineMatch {
  /** 1-based 行号 (在 srcSide 端的行号) */
  line: number;
  content: string;
  /** 该行在 diff 中的角色 */
  diffRole: 'added' | 'removed' | 'context';
  /** 该行属于 head 还是 base 文件 — 决定 onJumpToMatch 的 side 参数 */
  srcSide: 'old' | 'new';
  /** 匹配子串在 content 中的起止位置 (用于高亮渲染) */
  matchStart: number;
  matchEnd: number;
  /**
   * Monaco colorize 后的 HTML (含 inline style 语法着色)。第一波结果回来时为
   * undefined，后台 colorize 完成后异步填上，UI 再 update 一次。
   * 未着色时 fallback 到 renderHighlight 走纯文本 + 关键词 `<mark>`
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
 * 跨文件搜索主逻辑：
 *
 * 对每个 file:
 *   1. 拉 head + base 内容 (有缓存命中即跳过 IPC)
 *   2. 用 multiset consume 算"变更行"集合，扩展 ±CONTEXT_LINES 得到"可见范围"
 *      (跟用户在 Diff 视图能看到的 hunk 周围 context 对齐)
 *   3. 仅在可见范围内扫 line-by-line 找匹配
 *   4. head 命中：base 端也有 → context；否则 added
 *   5. base 命中且 head 端无：removed (排除已被 context 命中的)
 *   6. 同文件结果按 line 升序整理
 *
 * 单个文件失败 (binary / 拉取错误) 静默跳过，最后返回 partialError 提示有几个
 * 文件没搜成
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
        // 中途用户切到别的 query — 当前 promise 还没 return 就被取消，直接放弃
        if (token === -1) return;

        const headLines = headText === null ? [] : headText.split('\n');
        const baseLines = baseText === null ? [] : baseText.split('\n');
        // 用 Multiset 而非 Set — 同内容行可能出现多次 (空行 / 大括号 / 同名变量
        // 声明)。Set 会让"基础侧某次 instance 仍存在"误判为 context 跳过 added
        const baseLineCount = countLines(baseLines);
        const headLineCount = countLines(headLines);

        // 变更行集合 + ±CONTEXT_LINES context = 用户在 Diff 视图看得到的范围
        const changedHead = findChangedIndices(headLines, baseLineCount);
        const changedBase = findChangedIndices(baseLines, headLineCount);
        const visibleHead = expandToContext(changedHead, headLines.length);
        const visibleBase = expandToContext(changedBase, baseLines.length);

        const matches: LineMatch[] = [];
        // head 端扫
        for (let i = 0; i < headLines.length; i++) {
          if (!visibleHead.has(i)) continue;
          const line = headLines[i]!;
          const span = findMatchSpan(line, rawQuery, caseSensitive, probe);
          if (span === null) continue;
          // base 端有同样内容 → context；否则 added
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
        // base 端扫，仅收集"仅在 base 出现"的 removed 行 (避免跟 context 重复)
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
        // 排序：先按 srcSide (head 优先) 再按 line，让结果列表有可预测顺序
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

  // 文件级排序按 path 字典序，跟文件树视觉对齐
  out.sort((a, b) => a.file.path.localeCompare(b.file.path));
  return {
    results: out,
    partialError:
      failedCount > 0 ? t('diffSearchPanel.partialError', { count: failedCount }) : null,
  };
}

/**
 * 用 multiset consume 算"变更行"行号集合：other 端有同内容行就配对消费 (从
 * count 表里扣 1)，配不上的就是"仅在本侧出现" — 即变更行。
 *
 * 比简单 set 含 / 不含判定更准 — 同内容行 (空行 / `}` / 同名 import) 在 PR 一
 * 般是匹配存在，不是变更
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

/** 把变更行索引集合按 ±CONTEXT_LINES 扩展，并合并相邻区间 */
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
    // DiffFileContent 联合：{binary:false, content:string} 或 {binary:true}。
    // binary 文件跳过搜索 (没有可比对的文本)；non-binary 取 content 字段
    const text = c.binary === false ? c.content : null;
    cache.set(k, text);
    return text;
  } catch {
    cache.set(k, null);
    return null;
  }
}

/**
 * 剥行首缩进 (tab / 空格) — 搜索面板宽度有限，对齐到代码原缩进会浪费横向空间
 * 也让 match 看起来不显眼。剥掉后视觉上左对齐，关键词高亮起止点也按剥后内容
 * 重算。命中**在**缩进里 (query 包含 leading 空白) → 不剥，保持高亮位置正确
 */
export function stripLeadingIndent(
  line: string,
  span: [number, number],
): { content: string; matchStart: number; matchEnd: number } {
  const m = /^[\t ]+/.exec(line);
  if (!m) return { content: line, matchStart: span[0], matchEnd: span[1] };
  const offset = m[0].length;
  if (span[0] < offset) {
    // 命中在缩进区，剥了就高亮就错位 — 保留原内容
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
