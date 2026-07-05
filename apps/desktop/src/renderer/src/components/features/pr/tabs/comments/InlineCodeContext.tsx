// Must run before @monaco-editor/react is used (see the same note in DiffView). This file is
// dynamically loaded via React.lazy → Monaco is pulled on demand with this chunk, not in the entry bundle.
import '../../../../../lib/monaco-setup';
import { Editor, type Monaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PrCommentAnchor, StoredPullRequest } from '@meebox/shared';
import { EDITOR_FONT_SIZE_MIN } from '@meebox/shared';
import { invoke } from '../../../../../api';
import { editorFontSize } from '../../../../../lib/editor-font';
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
   * Whether to auto-mount the Monaco editor on entering the page. CommentsPanel passes true by default
   * for the latest N inline comments (AUTO_EXPAND_CAP), and false for the rest → renders an "expand code" button;
   * the editor mounts only when the user clicks (lazy load), avoiding slowing the page down all at once when a PR has many comments
   */
  autoExpand?: boolean;
}

/**
 * Inline code context referenced in a comment: a Monaco read-only editor showing a few lines around the anchored line,
 * with the anchored line highlighted by a full-line background (matching Bitbucket's inline-comment visual convention).
 *
 * Data comes from `diff:getFileContent` — the same local git blob as DiffView, no remote round trip;
 * when the mirror has not yet fetched the base/head sha (rare, poll already synced first) it falls back to syncMirror.
 *
 * Performance: each inline comment mounts a Monaco instance (read + tokenize). CommentsPanel controls this:
 * by default it only auto-expands the first N (by timeline); the rest use click-to-expand lazy loading.
 */
function InlineCodeContextImpl({
  pr,
  anchor,
  contextLines = 5,
  autoExpand = true,
}: InlineCodeContextProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(autoExpand);
  const [snippet, setSnippet] = useState<{
    text: string;
    startLine: number;
    anchorInSnippet: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Do not fetch the file while collapsed — gives the user active control over lazy-load semantics
    if (!expanded) return;
    let cancelled = false;
    setSnippet(null);
    setError(null);
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
        const allLines = c.content.split('\n');
        const startLine = Math.max(1, anchor.line - contextLines);
        const endLine = Math.min(allLines.length, anchor.line + contextLines);
        const text = allLines.slice(startLine - 1, endLine).join('\n');
        setSnippet({ text, startLine, anchorInSnippet: anchor.line - startLine + 1 });
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally not depending on t: useTranslation's t swaps to a new reference on i18n languageChanged (poll refresh may also trigger it),
    // putting it in deps would make this effect re-run pointlessly → setSnippet(null) → the embedded Monaco unmounts and rebuilds (refresh flicker).
    // t is only used for error text; the refetch timing should be decided solely by expanded / pr / anchor.
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

const READONLY_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  readOnly: true,
  // keep-alive: when the comment tab is switched away, this editor is display:none (size collapses to 0), and needs reflow on switch-back.
  // automaticLayout lets Monaco's built-in ResizeObserver auto-layout on show/hide, avoiding blank/misaligned rendering on switch-back.
  automaticLayout: true,
};

interface Snippet {
  text: string;
  startLine: number;
  anchorInSnippet: number;
}

/**
 * Read-only code snippet editor. **Standalone memo component**: props are only the stable snippet (same reference when value unchanged) + language,
 * fully isolated from any re-render of parent CommentItem / CommentsPanel (pr reference swaps triggered by poll / focus refresh, etc.).
 * On parent re-render this component bails via shallow props comparison → does not rebuild the <Editor> element → @monaco-editor/react's value /
 * options effects do not fire (avoiding the read-only editor being unconditionally reset by setValue → re-tokenize refresh flicker).
 * onMount / options also use stable references, eliminating updateOptions flicker even on re-render.
 */
const CodeSnippet = memo(function CodeSnippet({
  snippet,
  language,
}: {
  snippet: Snippet;
  language: string;
}) {
  // Monaco's built-in themes do not use CSS custom properties, so they must be switched explicitly: resolved by the editor theme preference ('auto' follows GUI light/dark).
  const monacoTheme = useMonacoEditorTheme();
  // Monospace font + font size switch with config. Inline snippets are 2px smaller than the main editor (preserving the historical look), track the configured font size, with a MIN lower bound;
  // line height scales proportionally to the font size. Font size / line height / font all go into options (@monaco-editor/react compares by reference, kept stable via useMemo).
  const appearance = useEditorAppearance();
  const fontFamily = resolveEditorFontFamily(appearance.fontFamily);
  const snippetFontSize = Math.max(EDITOR_FONT_SIZE_MIN, appearance.fontSize - 2);
  const lineHeight = Math.round(snippetFontSize * SNIPPET_LINE_HEIGHT_RATIO);
  const options = useMemo<editor.IStandaloneEditorConstructionOptions>(
    () => ({
      ...READONLY_OPTIONS,
      fontFamily,
      fontSize: editorFontSize(snippetFontSize),
      lineHeight,
    }),
    [fontFamily, snippetFontSize, lineHeight],
  );
  const lineCount = snippet.text.split('\n').length;
  const height = lineCount * lineHeight + 12;

  const handleMount = useCallback(
    (ed: editor.IStandaloneCodeEditor, monaco: Monaco): void => {
      // Real file line number = snippet-internal line number + startLine - 1. Monaco's functional lineNumbers
      // is fully controllable, mapping the internal 1..N back
      ed.updateOptions({
        readOnly: true,
        domReadOnly: true,
        lineNumbers: (lineNo) => String(lineNo + snippet.startLine - 1),
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        scrollbar: { vertical: 'hidden', horizontal: 'hidden', handleMouseWheel: false },
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        renderLineHighlight: 'none',
        contextmenu: false,
        folding: false,
        glyphMargin: false,
        // Font size / line height / font are driven uniformly by options (updated live with config), not fixed here.
        padding: { top: 6, bottom: 6 },
        // Line width adapts; long lines use word wrap instead of a horizontal scrollbar (scrollbars are disabled)
        wordWrap: 'on',
      });
      // Full-line background for the anchored line: via Monaco decorations. The line className lets CSS decide the color
      ed.createDecorationsCollection([
        {
          range: new monaco.Range(snippet.anchorInSnippet, 1, snippet.anchorInSnippet, 1),
          options: {
            isWholeLine: true,
            className: 'comment-code-context-anchor-line',
            marginClassName: 'comment-code-context-anchor-gutter',
          },
        },
      ]);
    },
    [snippet],
  );

  return (
    <div className="comment-code-context" style={{ height: `${String(height)}px` }}>
      <Editor
        height={`${String(height)}px`}
        language={language}
        value={snippet.text}
        theme={monacoTheme}
        onMount={handleMount}
        options={options}
      />
    </div>
  );
});

/**
 * A memo comparing by **anchor value** (path / line / side) + pr.localId + display options: on poll re-render the parent
 * (CommentsPanel) passes new anchor / pr **object references** (unchanged values), and the default shallow comparison would
 * mistake this for a change → embedded Monaco re-renders and reflows (refresh flicker). Here it compares by value, skipping the
 * whole component when the location info is unchanged, leaving Monaco untouched.
 */
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
