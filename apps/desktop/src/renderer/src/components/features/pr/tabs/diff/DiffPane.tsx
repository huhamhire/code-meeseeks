import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DiffEditor } from '@monaco-editor/react';
import { type editor as MonacoEditor } from 'monaco-editor';
import type { DiffChangedFile } from '@meebox/ipc';
import { editorFontSize } from '../../../../../lib/editor-font';
import { useMonacoEditorTheme } from '../../../../../hooks/useTheme';
import { useEditorAppearance } from '../../../../../stores/editor-appearance-store';
import { resolveEditorFontFamily } from '../../../../../theme';
import { languageFor } from '../../../../../utils/language';
import { formatBytes } from '../../../settings/utils';
import { PaneLoading } from '../../../../common';
import { Spinner } from './DiffStatus';
import type { LoadedContent } from './diff-types';

export function DiffPane({
  file,
  content,
  loading,
  renderSideBySide,
  showBlame,
  showWhitespace,
  onMount,
}: {
  file: DiffChangedFile;
  content: LoadedContent | null;
  loading: boolean;
  renderSideBySide: boolean;
  showBlame: boolean;
  showWhitespace: boolean;
  onMount: (editor: MonacoEditor.IStandaloneDiffEditor) => void;
}) {
  const { t } = useTranslation();
  // Monaco's built-in themes do not use CSS custom properties, so they must be switched explicitly: resolved by the editor theme preference ('auto' follows GUI light/dark).
  const monacoTheme = useMonacoEditorTheme();
  // Editor monospace font + font size: switch with config (empty font = Monaco default; font size gets a per-platform tweak).
  const editorAppearance = useEditorAppearance();
  const fontFamily = resolveEditorFontFamily(editorAppearance.fontFamily);
  // After Monaco mounts, the diff still needs async computation + hideUnchangedRegions collapsing before it stabilizes (see the reveal logic below),
  // during which the editor reflows from "empty → jump". Lay an overlay loading on top of it, unmount after the first onDidUpdateDiff
  // (or if already computed on mount), covering this flicker for a one-shot reveal. DiffPane is keyed by file path →
  // switching files naturally remounts, and diffReady resets with it.
  const [diffReady, setDiffReady] = useState(false);
  // options must use a stable useMemo reference: @monaco-editor/react compares options **by reference**, and any reference change triggers
  // editor.updateOptions(). The parent DiffView re-renders with poll (pr swaps to a new object reference) → DiffPane re-renders,
  // and if the options literal is rebuilt each time, every poll triggers updateOptions → hideUnchangedRegions collapse layout recompute →
  // editor render flicker. Rebuild only when items that truly matter (side-by-side / whitespace / font size) change.
  const fontSize = editorFontSize(editorAppearance.fontSize);
  const editorOptions = useMemo<MonacoEditor.IDiffEditorConstructionOptions>(
    () => ({
      readOnly: true,
      renderSideBySide,
      // keep-alive: when the tab is switched away, this editor is display:none (size collapses to 0), and needs reflow on switch-back. automaticLayout
      // lets Monaco's built-in ResizeObserver auto-layout on show/hide/size change, avoiding blank/misaligned rendering on switch-back.
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize,
      fontFamily,
      scrollBeyondLastLine: false,
      // Turn off the diff-specific merged overview column (renderOverviewRuler=true adds an extra wide column outside both scrollbars,
      // inconsistent with VS Code edit mode's "marks inside the scrollbar"). Go with the edit-mode effect instead: the inner modified editor's own
      // overview ruler (rendered by default, independent of the minimap) + inline comment decorations' overviewRuler projection (see useCommentZones).
      renderOverviewRuler: false,
      // Explicit 3 lanes: split the overview ruler into thirds (diff takes the left lane, comments the right, each 1/3 wide),
      // avoiding being computed as 2 lanes each taking half, for thinner color bars.
      overviewRulerLanes: 3,
      // Explicitly enable glyph margin, leaving room for inline comment markers
      glyphMargin: true,
      // Whitespace visualization: controlled by a toolbar button; when 'all', spaces show as · / Tab shows as →
      renderWhitespace: showWhitespace ? 'all' : 'none',
      // GitHub-style folding: unchanged sections collapse into expandable placeholder rows
      hideUnchangedRegions: {
        enabled: true,
        contextLineCount: 10,
        minimumLineCount: 5,
        revealLineCount: 20,
      },
      // Turn off advanced features that depend on ts.worker (diff review does not need them), which also silences
      // the `Missing requestHandler` noise. hover is kept for blame / comment decorations.
      inlayHints: { enabled: 'off' },
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      parameterHints: { enabled: false },
      codeLens: false,
      stickyScroll: { enabled: false },
      occurrencesHighlight: 'off',
    }),
    [renderSideBySide, showWhitespace, fontSize, fontFamily],
  );
  const handleMount = useCallback(
    (editor: MonacoEditor.IStandaloneDiffEditor) => {
      onMount(editor);
      // The diff computation fires onDidUpdateDiff, but the hideUnchangedRegions collapse layout still needs another
      // frame or two of painting to stabilize → do not reveal immediately in the event (else the collapse jump shows); wait ~80ms to let the collapse
      // paint finish while the overlay stays on, then reveal in one shot.
      const reveal = (): void => {
        window.setTimeout(() => setDiffReady(true), 80);
      };
      if (editor.getLineChanges() != null) {
        reveal();
        return;
      }
      const d = editor.onDidUpdateDiff(() => {
        d.dispose();
        reveal();
      });
    },
    [onMount],
  );
  if (loading || !content) {
    return (
      <div className="diff-empty">
        <span className="muted">
          <Spinner /> {t('diffView.loadingContentPrefix')} <code>{file.path}</code>{' '}
          {t('diffView.loadingContentSuffix')}
          <br />
          <small>{t('diffView.loadingContentHint')}</small>
        </span>
      </div>
    );
  }
  if (content.base.binary || content.head.binary) {
    // Git LFS status: prefer the head side's pointer info (the current version), fall back to base (e.g. a deleted file).
    const headLfs = content.head.binary ? content.head.lfs : undefined;
    const baseLfs = content.base.binary ? content.base.lfs : undefined;
    const lfs = headLfs ?? baseLfs;
    return (
      <div className="diff-binary">
        <span>{t('diffView.binaryNotRendered')}</span>
        {lfs ? (
          <span className="diff-lfs-tag" title={t('diffView.lfsManagedTitle')}>
            Git LFS{lfs.size != null ? ` · ${formatBytes(lfs.size)}` : ''}
          </span>
        ) : (
          <span className="diff-nonlfs-tag" title={t('diffView.notLfsTitle')}>
            <span className="diff-lfs-icon" aria-hidden="true">
              ⚠️
            </span>
            {t('diffView.notLfs')}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="diff-pane-editor">
      {!diffReady && <PaneLoading overlay delayMs={0} />}
      <DiffEditor
        height="100%"
        language={languageFor(file.path)}
        original={content.base.content}
        modified={content.head.content}
        onMount={handleMount}
        className={
          [showBlame ? 'diff-editor-with-blame' : '', showWhitespace ? 'diff-editor-show-eol' : '']
            .filter(Boolean)
            .join(' ') || undefined
        }
        options={editorOptions}
        theme={monacoTheme}
      />
    </div>
  );
}
