import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { editor as MonacoEditorNs } from 'monaco-editor';
import type { DiffChangedFile } from '@meebox/shared';
import { invoke } from '../../../../../api';
import { languageFor } from '../../../../../utils/language';

/**
 * 搜索 PR diff 全部变更文件内容。仿 Bitbucket "Search code" 入口的行为：
 *
 * - query 在 head + base 两端 line-by-line 找匹配
 * - 每个匹配行带 side 标记：
 *     'added'   — 仅出现在 head 端 (前缀 `+`)
 *     'removed' — 仅出现在 base 端 (前缀 `-`)
 *     'context' — 两端都有相同内容 (无前缀)
 * - 按文件 group，文件名右侧 badge 显示该文件匹配数
 * - 文件级 expand/collapse，默认全展开
 * - 点击某条结果 → 调 onJumpToMatch 切换文件 + scroll 到对应行
 *
 * 性能：每个文件并行 invoke 两次 diff:getFileContent (base + head)。常规 PR 几十
 * 文件 × 几百行毫秒级；> 200 行结果时折叠"显示更多"避免一次渲染过载
 */

interface DiffSearchPanelProps {
  files: DiffChangedFile[];
  prLocalId: string;
  onJumpToMatch: (file: DiffChangedFile, line: number, side: 'old' | 'new') => void;
  /**
   * 用户按 Esc 时调 — 父端通常把 sidebarMode 切回 'tree'。无论焦点在 input 还是
   * 结果列表都生效 (走 window 层 keydown)
   */
  onExit?: () => void;
}

const CASE_SENSITIVE_LS_KEY = 'meebox.diffSearch.caseSensitive';

interface LineMatch {
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

interface FileResults {
  file: DiffChangedFile;
  matches: LineMatch[];
}

/** 大文件保护：单文件超过 N 条命中只展示前 N + "更多" */
const PER_FILE_MATCH_CAP = 200;

const SEARCH_DEBOUNCE_MS = 220;

/**
 * 搜索范围限制：仅扫"变更行 + 上下 N 行 context"，跟 Monaco DiffEditor 视觉上
 * 用户能看到的"diff 周围若干行 context"对齐。N=10 比 git diff 默认 unified=3
 * 更宽松，让搜索能命中变更附近稍远的引用 (常见场景：改了某个函数实现，调用方
 * 在其上下 5-10 行能被搜到)
 */
const CONTEXT_LINES = 10;

export function DiffSearchPanel({
  files,
  prLocalId,
  onJumpToMatch,
  onExit,
}: DiffSearchPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  // 大小写敏感跨 session 持久化 — 用户习惯一旦定下来 (一般是关或开)，每次
  // 进搜索面板都得重新切一次很烦。localStorage 写一次就记住
  const [caseSensitive, setCaseSensitive] = useState<boolean>(() => {
    try {
      return localStorage.getItem(CASE_SENSITIVE_LS_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(CASE_SENSITIVE_LS_KEY, caseSensitive ? '1' : '0');
    } catch {
      // 隐私模式 / 配额满 等失败静默，不影响搜索功能
    }
  }, [caseSensitive]);
  const [results, setResults] = useState<FileResults[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 默认全部展开 — 用户已经主动搜索，不需要再点一次才看结果
  const [collapsedFiles, setCollapsedFiles] = useState<ReadonlySet<string>>(new Set());

  // 当前 search session 的 token，让旧的异步任务发现自己被取消
  const sessionRef = useRef(0);
  // 内容缓存：同一个 PR 搜不同关键字时 invoke diff:getFileContent 拿过的不重复拉
  // key: `${side}:${path}` → text content
  const contentCacheRef = useRef<Map<string, string | null>>(new Map());
  // PR 切换时清缓存
  useEffect(() => {
    contentCacheRef.current = new Map();
  }, [prLocalId]);

  // mount 时自动聚焦输入框，省一次点击
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Esc 退出搜索：用 window capture-stage listener 让焦点在 input / 结果按钮 /
  // 任何子元素都生效。子元素的 input 自带 Esc 清空行为浏览器不一定有 (type=text)
  // 不会跟它冲突
  useEffect(() => {
    if (!onExit) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onExit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    const token = ++sessionRef.current;
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void runSearch(token, q, caseSensitive, files, prLocalId, contentCacheRef.current, t)
        .then(({ results: r, partialError }) => {
          if (token !== sessionRef.current) return;
          // 先显示带 <mark> 关键词高亮的纯文本结果 — 用户立刻能看到命中
          setResults(r);
          setError(partialError);
          // 异步着色：Monaco colorize 按文件 language 串行执行；token 跟 session
          // 关联，过期 session 不再 update state
          void colorizeAll(r, token, sessionRef).then((colorized) => {
            if (token === sessionRef.current) setResults(colorized);
          });
        })
        .catch((e: unknown) => {
          if (token !== sessionRef.current) return;
          setError(e instanceof Error ? e.message : String(e));
          setResults([]);
        })
        .finally(() => {
          if (token === sessionRef.current) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query, caseSensitive, files, prLocalId, t]);

  const totalMatches = useMemo(
    () => results.reduce((n, fr) => n + fr.matches.length, 0),
    [results],
  );

  const toggleFile = (path: string): void => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="diff-search-panel">
      <div className="diff-search-input-row">
        <input
          ref={inputRef}
          type="text"
          className="diff-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('diffSearchPanel.searchPlaceholder')}
          aria-label={t('diffSearchPanel.searchAria')}
        />
        <button
          type="button"
          className={`diff-search-case-toggle${caseSensitive ? ' active' : ''}`}
          onClick={() => setCaseSensitive((c) => !c)}
          title={caseSensitive ? t('diffSearchPanel.caseSensitiveOn') : t('diffSearchPanel.caseSensitiveOff')}
          aria-pressed={caseSensitive}
        >
          Aa
        </button>
      </div>
      {query.trim() && (
        <div className="diff-search-stats muted">
          {loading
            ? t('diffSearchPanel.searching')
            : t('diffSearchPanel.matchStats', { matches: totalMatches, files: results.length })}
        </div>
      )}
      {error && (
        <div className="diff-search-error" role="alert">
          {error}
        </div>
      )}
      <ul className="diff-search-results">
        {results.map((fr) => {
          const collapsed = collapsedFiles.has(fr.file.path);
          const shown = fr.matches.slice(0, PER_FILE_MATCH_CAP);
          const overflow = fr.matches.length - shown.length;
          return (
            <li key={fr.file.path} className="diff-search-file">
              <button
                type="button"
                className="diff-search-file-head"
                onClick={() => toggleFile(fr.file.path)}
                title={fr.file.path}
              >
                <span
                  className={`diff-search-file-chevron${collapsed ? ' collapsed' : ''}`}
                  aria-hidden="true"
                >
                  ▾
                </span>
                <span className="diff-search-file-name">{basename(fr.file.path)}</span>
                <span className="diff-search-file-path muted">{dirname(fr.file.path)}</span>
                <span className="diff-search-file-count">{fr.matches.length}</span>
              </button>
              {!collapsed && (
                <ul className="diff-search-file-matches">
                  {shown.map((m, i) => (
                    <li key={`${m.srcSide}:${String(m.line)}:${String(i)}`}>
                      <button
                        type="button"
                        className="diff-search-match"
                        onClick={() => onJumpToMatch(fr.file, m.line, m.srcSide)}
                        title={t('diffSearchPanel.jumpToLineTitle', {
                          side: m.srcSide === 'new' ? 'head' : 'base',
                          line: m.line,
                        })}
                      >
                        <span
                          className={`diff-search-match-marker diff-search-match-marker-${m.diffRole}`}
                          aria-hidden="true"
                        >
                          {m.diffRole === 'added' ? '+' : m.diffRole === 'removed' ? '-' : ' '}
                        </span>
                        <span className="diff-search-match-line">{m.line}</span>
                        {/* colorize 完成后用 dangerouslySetInnerHTML 渲染带语法
                            着色的 HTML；未完成 / plaintext 文件走 fallback 走纯
                            文本 + 关键词 <mark> 高亮 */}
                        {m.colorizedHtml ? (
                          <span
                            className="diff-search-match-content"
                            dangerouslySetInnerHTML={{ __html: m.colorizedHtml }}
                          />
                        ) : (
                          <span className="diff-search-match-content">
                            {renderHighlight(m.content, m.matchStart, m.matchEnd)}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                  {overflow > 0 && (
                    <li className="diff-search-match-overflow muted">
                      {t('diffSearchPanel.matchOverflow', {
                        overflow,
                        cap: PER_FILE_MATCH_CAP,
                      })}
                    </li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
        {!loading && query.trim() && results.length === 0 && !error && (
          <li className="diff-search-empty muted">{t('diffSearchPanel.noMatch')}</li>
        )}
      </ul>
    </div>
  );
}

/**
 * 关键词高亮：把 content 按 [matchStart, matchEnd) 拆三段，中间一段套 <mark>。
 * 只高亮第一处命中，避免渲染额外计算
 */
function renderHighlight(content: string, start: number, end: number): React.ReactNode {
  if (start < 0 || end <= start) return content;
  return (
    <>
      {content.slice(0, start)}
      <mark className="diff-search-highlight">{content.slice(start, end)}</mark>
      {content.slice(end)}
    </>
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}
function dirname(p: string): string {
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
async function runSearch(
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
function findChangedIndices(
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
function expandToContext(changed: Set<number>, total: number): Set<number> {
  const out = new Set<number>();
  for (const idx of changed) {
    const lo = Math.max(0, idx - CONTEXT_LINES);
    const hi = Math.min(total - 1, idx + CONTEXT_LINES);
    for (let j = lo; j <= hi; j++) out.add(j);
  }
  return out;
}

/**
 * 异步着色：对每个 file 的每条 match.content 用 Monaco colorize 加语法高亮。
 *
 * Monaco colorize 返回带 inline style 的 HTML — 不依赖 monaco theme CSS，
 * dangerouslySetInnerHTML 即可用。串行 file 但并发 line 平衡 throughput vs
 * 启动开销 (一个文件的 language 加载只一次)。
 *
 * session token 检查：search session 已经被新 query 取代时立即放弃，避免
 * setState 到过期结果上
 */
async function colorizeAll(
  results: FileResults[],
  token: number,
  sessionRef: React.RefObject<number>,
): Promise<FileResults[]> {
  const out: FileResults[] = [];
  for (const fr of results) {
    if (token !== sessionRef.current) return results;
    const langId = languageFor(fr.file.path);
    // plaintext 文件没意义着色 — 直接复用原 matches
    if (langId === 'plaintext') {
      out.push(fr);
      continue;
    }
    const colorized = await Promise.all(
      fr.matches.map(async (m) => {
        try {
          const html = await MonacoEditorNs.colorize(m.content, langId, { tabSize: 2 });
          // colorize 输出末尾会加 `<br/>`；裁掉避免行高跳一档
          return { ...m, colorizedHtml: html.replace(/<br\/?>$/i, '') };
        } catch {
          return m;
        }
      }),
    );
    out.push({ ...fr, matches: colorized });
  }
  return out;
}

async function loadContent(
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
function stripLeadingIndent(
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

function countLines(lines: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
}

function findMatchSpan(
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
