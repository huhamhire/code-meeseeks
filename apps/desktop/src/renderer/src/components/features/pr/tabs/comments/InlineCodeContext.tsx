import { editor } from 'monaco-editor';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PrCommentAnchor, StoredPullRequest } from '@meebox/shared';
import { EDITOR_FONT_SIZE_MIN } from '@meebox/shared';
import { invoke } from '../../../../../api';
import { editorFontSize } from '../../../../../lib/editor-font';
import { getEditorThemeColors } from '../../../../../lib/monaco-setup';
import { useMonacoEditorTheme } from '../../../../../hooks/useTheme';
import { useEditorAppearance } from '../../../../../stores/editor-appearance-store';
import { resolveEditorFontFamily } from '../../../../../theme';
import { languageFor } from '../../../../../utils/language';

interface InlineCodeContextProps {
  pr: StoredPullRequest;
  anchor: PrCommentAnchor;
  /** Number of context lines shown around the anchored line; defaults to 5 */
  contextLines?: number;
  /**
   * Whether to fetch and display the code on entering the page. Older comments load the preview on demand.
   */
  autoExpand?: boolean;
}

/**
 * Shows a few lines from the same local git blob as the diff, with a full-row highlight on the comment's anchor.
 */
function InlineCodeContextImpl({
  pr,
  anchor,
  contextLines = 5,
  autoExpand = true,
}: InlineCodeContextProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(autoExpand);
  const [snippet, setSnippet] = useState<Snippet | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Do not fetch the file while collapsed — gives the user active control over lazy-load semantics
    if (!expanded) return;
    let cancelled = false;
    setSnippet(null);
    setError(null);
    // File-level anchors (no line) have no line to contextualize; the caller doesn't mount this for them, but guard anyway.
    // Capture as a const so the narrowing carries into the async closure below.
    const line = anchor.line;
    if (line == null) return;
    void (async () => {
      try {
        const c = await invoke('diff:getFileContent', {
          localId: pr.localId,
          // anchor.side 'old' anchors to the base side, 'new' anchors to the head side
          side: anchor.side === 'old' ? 'base' : 'head',
          path: anchor.path,
        });
        if (cancelled) return;
        if (c.binary) {
          setError(t('inlineCodeContext.binaryNoContext'));
          return;
        }
        const allLines = c.content.split(/\r\n|\r|\n/);
        const startLine = Math.max(1, line - contextLines);
        const endLine = Math.min(allLines.length, line + contextLines);
        const text = allLines.slice(startLine - 1, endLine).join('\n');
        setSnippet({ text, startLine, anchorInSnippet: line - startLine + 1 });
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only changes to the file or anchor should refetch code. The translation is used for error text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, pr.localId, anchor.path, anchor.side, anchor.line, contextLines]);

  if (!expanded) {
    return (
      <button
        type="button"
        className="comment-code-context-toggle"
        onClick={() => setExpanded(true)}
        title={t('inlineCodeContext.expandTitle')}
      >
        {t('inlineCodeContext.expandLabel', { path: anchor.path, line: anchor.line })}
      </button>
    );
  }
  if (error) {
    return <div className="comment-code-context-error muted">{error}</div>;
  }
  if (!snippet) {
    return (
      <div className="comment-code-context-loading muted">{t('inlineCodeContext.loading')}</div>
    );
  }

  return <CodeSnippet snippet={snippet} language={languageFor(anchor.path)} />;
}

/** Inline snippet line-height / font-size ratio (derived from line-height 19 at fs=12); scales line height proportionally to the configured font size. */
const SNIPPET_LINE_HEIGHT_RATIO = 19 / 12;

interface Snippet {
  text: string;
  startLine: number;
  anchorInSnippet: number;
}

const CodeSnippet = memo(function CodeSnippet({
  snippet,
  language,
}: {
  snippet: Snippet;
  language: string;
}) {
  const theme = useMonacoEditorTheme();
  const colors = getEditorThemeColors(theme)?.colors;
  const appearance = useEditorAppearance();
  const fontSize = Math.max(EDITOR_FONT_SIZE_MIN, appearance.fontSize - 2);
  const [highlight, setHighlight] = useState<{
    snippet: Snippet;
    language: string;
    theme: string;
    lines: (string | undefined)[];
  } | null>(null);

  useEffect(() => {
    editor.setTheme(theme);
    if (language === 'plaintext') return;

    let cancelled = false;
    // Colorize the entire snippet to preserve token state across its lines.
    void editor.colorize(snippet.text, language, { tabSize: 1 }).then(
      (html) => {
        if (cancelled) return;
        // Monaco emits escaped source text and token spans, ending each line with a <br/>.
        const colorizedLines = html.split('<br/>');
        const lines = snippet.text.split('\n').map((line, index) => {
          if (!line) return '';
          // Monaco emits one non-breaking space per space or tab at tabSize 1. Restore
          // the original whitespace for browser wrapping and copying.
          const whitespace = line.match(/[ \t\u00a0]/g) ?? [];
          let offset = 0;
          return colorizedLines[index]?.replace(/\u00a0/g, () => whitespace[offset++] ?? ' ');
        });
        setHighlight({ snippet, language, theme, lines });
      },
      () => {
        // Keep the selectable plaintext when tokenization is unavailable.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [snippet, language, theme]);

  const highlightedLines =
    highlight?.snippet === snippet && highlight.language === language && highlight.theme === theme
      ? highlight.lines
      : undefined;
  return (
    <pre
      className="comment-code-context"
      style={{
        backgroundColor: colors?.['editor.background'],
        color: colors?.['editor.foreground'],
        fontFamily: resolveEditorFontFamily(appearance.fontFamily),
        fontSize: editorFontSize(fontSize),
        lineHeight: `${String(Math.round(fontSize * SNIPPET_LINE_HEIGHT_RATIO))}px`,
      }}
    >
      {snippet.text.split('\n').map((line, index) => {
        const lineNumber = snippet.startLine + index;
        const html = highlightedLines?.[index];
        return (
          <span
            key={lineNumber}
            className={`comment-code-context-row${index + 1 === snippet.anchorInSnippet ? ' comment-code-context-anchor-line' : ''}`}
          >
            <span className="comment-code-context-line-number" aria-hidden="true">
              {lineNumber}
            </span>
            {html === undefined ? (
              <code>{line}</code>
            ) : (
              <code dangerouslySetInnerHTML={{ __html: html }} />
            )}
          </span>
        );
      })}
    </pre>
  );
});

// Keep the preview stable when polling replaces the PR and anchor objects.
export const InlineCodeContext = memo(
  InlineCodeContextImpl,
  (prev, next) =>
    prev.pr.localId === next.pr.localId &&
    prev.anchor.path === next.anchor.path &&
    prev.anchor.line === next.anchor.line &&
    prev.anchor.side === next.anchor.side &&
    (prev.contextLines ?? 5) === (next.contextLines ?? 5) &&
    (prev.autoExpand ?? true) === (next.autoExpand ?? true),
);
