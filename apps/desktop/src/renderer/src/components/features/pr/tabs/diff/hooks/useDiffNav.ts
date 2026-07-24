import { useEffect, useState } from 'react';
import { type editor as MonacoEditor } from 'monaco-editor';
import type { ReviewDraft } from '@meebox/shared';
import type { DiffChangedFile } from '@meebox/ipc';
import { fileKey, type LoadedContent } from '../diff-types';
import { mapOriginalLineToModified } from '../zones/line-mapping';
import { isActualSideBySide } from './useActualRenderSideBySide';

export interface PendingScroll {
  line: number;
  side: 'old' | 'new';
  draftId?: string;
}

export interface PendingNav {
  runId?: string;
  findingId?: string;
  anchor: { path: string; startLine: number; endLine: number; side?: 'old' | 'new' };
}

/**
 * Navigation consumption: from ChatPane → App.pendingDiffNav. Set selectedKey to switch to the target file + find the associated draft,
 * then the reveal side effect waits for selected / diffEditor / drafts to be ready before revealLine + brief highlight + autoEdit.
 * Also exposes pendingScroll for cross-file search navigation (DiffSearchPanel) to reuse.
 */
export function useDiffNav(opts: {
  files: DiffChangedFile[] | null;
  drafts: readonly ReviewDraft[] | null;
  diffEditor: MonacoEditor.IStandaloneDiffEditor | null;
  content: LoadedContent | null;
  selected: DiffChangedFile | null;
  setSelectedKey: React.Dispatch<React.SetStateAction<string | null>>;
  pendingNav: PendingNav | null | undefined;
  onNavConsumed: (() => void) | undefined;
  triggerAutoEdit: (draftId: string) => void;
  /** Toolbar intent; the reveal reads the ACTUAL mode from this at reveal time (see isActualSideBySide) to place old-side targets. */
  renderSideBySide: boolean;
}): {
  pendingScroll: PendingScroll | null;
  setPendingScroll: React.Dispatch<React.SetStateAction<PendingScroll | null>>;
} {
  const {
    files,
    drafts,
    diffEditor,
    content,
    selected,
    setSelectedKey,
    pendingNav,
    onNavConsumed,
    triggerAutoEdit,
    renderSideBySide,
  } = opts;
  const [pendingScroll, setPendingScroll] = useState<PendingScroll | null>(null);

  useEffect(() => {
    if (!pendingNav || !files) return;
    const target = files.find(
      (f) => f.path === pendingNav.anchor.path || f.oldPath === pendingNav.anchor.path,
    );
    if (target) {
      setSelectedKey(fileKey(target));
    }
    // Look up the existing draft; ChatPane has already lazily created it, so normally it's found.
    // No runId/findingId passed (PublishReviewModal anchor click scenario) → skip the lookup directly,
    // draftId stays undefined → downstream effect won't trigger autoEdit, pure navigate
    const matchingDraft =
      pendingNav.runId && pendingNav.findingId
        ? (drafts ?? []).find(
            (d) =>
              d.source !== undefined &&
              d.source.runId === pendingNav.runId &&
              d.source.findingId === pendingNav.findingId,
          )
        : undefined;
    setPendingScroll({
      // Take endLine to align with the draft zone / publish anchor (see zone line number comment), so the highlight line matches the draft zone
      line: pendingNav.anchor.endLine,
      // Preserve the anchor's side so an old-side (base) comment/draft reveals on the correct side; older producers that
      // don't carry side fall back to 'new' (head), the common case for code-review findings.
      side: pendingNav.anchor.side ?? 'new',
      draftId: matchingDraft?.id,
    });
    onNavConsumed?.();
    // drafts not in deps — already acked when nav arrives; later drafts changes shouldn't retrigger this logic
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNav, files, onNavConsumed]);

  // nav consumption complete: scroll + highlight + autoEdit the associated draft. Wait for the selected file
  // switch + content load + diffEditor ready + drafts hydrated, then revealLine.
  // pendingScroll comes from the nav effect (set alongside setSelectedKey); cleared after reveal
  useEffect(() => {
    if (!pendingScroll || !diffEditor || !content || !selected) return;

    let highlightTimer: ReturnType<typeof setTimeout> | undefined;
    let revealed = false;
    const reveal = () => {
      // onDidUpdateDiff may fire multiple times, only jump once
      if (revealed) return;
      revealed = true;
      // Resolve the target editor + line by side AND the ACTUAL render mode (read live here, after the diff has settled
      // and Monaco's `.side-by-side` class is stable). An old-side target sits on the original editor only when it is
      // genuinely visible; when Monaco has auto-degraded to unified the original editor is hidden, so remap the old line
      // onto the modified editor (same mapping the old-side zones use) and reveal there — otherwise the reveal lands on
      // an invisible editor / the wrong line.
      const revealOld =
        pendingScroll.side === 'old' && isActualSideBySide(diffEditor, renderSideBySide);
      const editor = revealOld ? diffEditor.getOriginalEditor() : diffEditor.getModifiedEditor();
      const line =
        pendingScroll.side === 'old' && !revealOld
          ? mapOriginalLineToModified(diffEditor.getLineChanges() ?? [], pendingScroll.line)
          : pendingScroll.line;
      // Center-scroll to the target line
      editor.revealLineInCenter(line);
      // Brief highlight: 300ms yellow-background pulse
      const collection = editor.createDecorationsCollection([
        {
          range: {
            startLineNumber: line,
            startColumn: 1,
            endLineNumber: line,
            endColumn: 1,
          },
          options: {
            isWholeLine: true,
            className: 'monaco-draft-highlight-flash',
          },
        },
      ]);
      highlightTimer = setTimeout(() => {
        try {
          collection.clear();
        } catch {
          /* editor disposed */
        }
      }, 800);
      // Also trigger autoEdit for the associated draft (DraftZone auto-enters edit mode)
      if (pendingScroll.draftId) {
        triggerAutoEdit(pendingScroll.draftId);
      }
      setPendingScroll(null);
    };

    // Monaco diff is computed asynchronously: after models mount (onMount) it still waits for diff computation +
    // hideUnchangedRegions collapse layout to complete before the line-number-to-viewport-position mapping is stable. At this point
    // revealLine directly would locate to the old layout / wrong position. getLineChanges() returns null before
    // computation finishes, returns an array after → already ready jump directly, otherwise wait for onDidUpdateDiff to first fire.
    if (diffEditor.getLineChanges() != null) {
      reveal();
      return () => {
        if (highlightTimer) clearTimeout(highlightTimer);
      };
    }
    const disposable = diffEditor.onDidUpdateDiff(reveal);
    return () => {
      disposable.dispose();
      if (highlightTimer) clearTimeout(highlightTimer);
    };
    // triggerAutoEdit not in deps — it changes reference every render, including it would make reveal rerun every frame, repeatedly locating/highlighting
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScroll, diffEditor, content, selected, renderSideBySide]);

  return { pendingScroll, setPendingScroll };
}
