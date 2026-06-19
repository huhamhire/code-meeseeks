import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { DiffChangedFile } from '@meebox/ipc';
import { PER_FILE_MATCH_CAP, basename, dirname } from './search/diff-search';
import { useDiffSearch } from './search/useDiffSearch';

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
 * 搜索算法见 [search/diff-search](./search/diff-search.ts)，状态机见
 * [search/useDiffSearch](./search/useDiffSearch.ts)；本组件只负责渲染。
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

export function DiffSearchPanel({ files, prLocalId, onJumpToMatch, onExit }: DiffSearchPanelProps) {
  const { t } = useTranslation();
  const {
    query,
    setQuery,
    caseSensitive,
    setCaseSensitive,
    results,
    loading,
    error,
    collapsedFiles,
    toggleFile,
    totalMatches,
    inputRef,
  } = useDiffSearch(files, prLocalId);

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
          title={
            caseSensitive
              ? t('diffSearchPanel.caseSensitiveOn')
              : t('diffSearchPanel.caseSensitiveOff')
          }
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
