import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { DiffChangedFile } from '@meebox/ipc';
import { PER_FILE_MATCH_CAP, basename, dirname } from './search/diff-search';
import { useDiffSearch } from './search/useDiffSearch';

/**
 * Search the content of all changed files in the PR diff. Mimics the behavior of Bitbucket's "Search code" entry:
 *
 * - query matches line-by-line on both the head + base sides
 * - each matched line carries a side marker:
 *     'added'   — appears only on the head side (prefix `+`)
 *     'removed' — appears only on the base side (prefix `-`)
 *     'context' — same content on both sides (no prefix)
 * - grouped by file, a badge to the right of the file name shows that file's match count
 * - file-level expand/collapse, all expanded by default
 * - clicking a result → calls onJumpToMatch to switch file + scroll to the corresponding line
 *
 * Search algorithm in [search/diff-search](./search/diff-search.ts), state machine in
 * [search/useDiffSearch](./search/useDiffSearch.ts); this component only handles rendering.
 */

interface DiffSearchPanelProps {
  files: DiffChangedFile[];
  prLocalId: string;
  onJumpToMatch: (file: DiffChangedFile, line: number, side: 'old' | 'new') => void;
  /**
   * Called when the user presses Esc — the parent usually switches sidebarMode back to 'tree'. Works whether focus is
   * on the input or the result list (via a window-level keydown)
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

  // Esc to exit search: a window capture-stage listener makes it work whether focus is on the input / result button /
  // any child element. Browsers don't necessarily give a child input a built-in Esc-to-clear behavior (type=text)
  // so there's no conflict with it
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
                        {/* Once colorize finishes, render the syntax-colored HTML via
                            dangerouslySetInnerHTML; not-yet-done / plaintext files fall
                            back to plain text + keyword <mark> highlight */}
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
 * Keyword highlight: split content into three parts by [matchStart, matchEnd), wrapping the middle part in <mark>.
 * Only highlights the first hit, avoiding extra render computation
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
