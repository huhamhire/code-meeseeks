import { useEffect } from 'react';
import { type editor as MonacoEditor } from 'monaco-editor';
import type { DiffChangedFile } from '@meebox/ipc';
import { selectionStore } from '../../../../../../stores/selection-store';

const DEBOUNCE_MS = 120;

/**
 * Captures the code selection in the Diff → writes it to selectionStore, so ChatPane can carry the selected code as implicit context into a question.
 *
 * Listens to onDidChangeCursorSelection on the two inner sub-editors (modified=new/head, original=base/old); an empty selection
 * (collapsed to a cursor, no text) → clear, otherwise write after a ~120ms debounce. A Monaco diff sub-editor's line number is that side's displayed file
 * line number, so no hunk mapping is needed. On file / PR switch or unmount (dependency change triggers cleanup), it clears too, avoiding stale selection residue.
 *
 * Deliberately does **not** apply the "commentable region" guard (useLineCommentAdder's isAllowed): inline comments are constrained by the platform anchor
 * and can only attach to diff-hit lines; whereas a selection reference is only model context and is not written back to the remote, so any selectable code (including unchanged context lines) can be
 * referenced — precisely that context is most useful for a question and should not be blocked by the comment constraint.
 *
 * In unified (inline) view, Monaco's classic inline diff renders deleted lines as view-zones inside the modified editor (not the text line of any
 * model), and the original editor width collapses to 0 → deleted lines cannot be cursor-selected. To let deleted content also be referenced "like added lines":
 * when the head selection spans a deletion/change hunk, based on getLineChanges() the corresponding base lines are taken from the original model and written into the selection as
 * removed (see spannedDeletions). In side-by-side view, deleted lines can be selected directly in the original editor, so this augmentation is not done.
 */
export function useSelectionCapture(opts: {
  diffEditor: MonacoEditor.IStandaloneDiffEditor | null;
  selected: DiffChangedFile | null;
  prLocalId: string;
  renderSideBySide: boolean;
}): void {
  const { diffEditor, selected, prLocalId, renderSideBySide } = opts;
  useEffect(() => {
    if (!diffEditor || !selected) return;
    const modified = diffEditor.getModifiedEditor();
    const original = diffEditor.getOriginalEditor();
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Unified view: find the base-side original lines (with real code) of the deletion/change hunks that the head selection [s,e] spans.
    const spannedDeletions = (
      s: number,
      e: number,
    ): { startLine: number; endLine: number; text: string } | undefined => {
      const origModel = original.getModel();
      if (!origModel) return undefined;
      const segs: Array<{ oStart: number; oEnd: number }> = [];
      for (const c of diffEditor.getLineChanges() ?? []) {
        // Base lines with deletion/change (pure addition originalEndLineNumber===0 → skip).
        if (c.originalStartLineNumber <= 0 || c.originalEndLineNumber <= 0) continue;
        const modStart = c.modifiedStartLineNumber;
        const modEnd = c.modifiedEndLineNumber > 0 ? c.modifiedEndLineNumber : c.modifiedStartLineNumber;
        // The hunk's landing on the modified side overlaps the selection [s,e] → treated as spanned by the selection.
        if (modEnd < s || modStart > e) continue;
        segs.push({ oStart: c.originalStartLineNumber, oEnd: c.originalEndLineNumber });
      }
      if (segs.length === 0) return undefined;
      const oStart = Math.min(...segs.map((x) => x.oStart));
      const oEnd = Math.max(...segs.map((x) => x.oEnd));
      const text = segs
        .map((x) =>
          origModel.getValueInRange({
            startLineNumber: x.oStart,
            startColumn: 1,
            endLineNumber: x.oEnd,
            endColumn: origModel.getLineMaxColumn(x.oEnd),
          }),
        )
        .join('\n');
      return { startLine: oStart, endLine: oEnd, text };
    };

    const capture = (ed: MonacoEditor.ICodeEditor, side: 'old' | 'new'): void => {
      const sel = ed.getSelection();
      const model = ed.getModel();
      // Empty selection (cursor collapsed, no selected text) → clear.
      if (!sel || !model || (sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn)) {
        selectionStore.clear();
        return;
      }
      // When the selection reaches the next line's start (endColumn===1), that line has no actual text and is not counted in the line count.
      const endLine =
        sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber
          ? sel.endLineNumber - 1
          : sel.endLineNumber;
      const startLine = sel.startLineNumber;
      // Unified view + head selection: augment with the spanned base deleted lines (in side-by-side view deleted lines can be selected directly, no augmentation).
      const removed =
        side === 'new' && !renderSideBySide ? spannedDeletions(startLine, endLine) : undefined;
      selectionStore.set({
        prLocalId,
        path: side === 'old' ? (selected.oldPath ?? selected.path) : selected.path,
        side,
        startLine,
        endLine,
        lineCount: endLine - startLine + 1,
        text: model.getValueInRange(sel),
        removed,
      });
    };

    const onChange = (ed: MonacoEditor.ICodeEditor, side: 'old' | 'new'): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => capture(ed, side), DEBOUNCE_MS);
    };

    const disposables = [
      modified.onDidChangeCursorSelection(() => onChange(modified, 'new')),
      original.onDidChangeCursorSelection(() => onChange(original, 'old')),
    ];
    return () => {
      if (timer) clearTimeout(timer);
      for (const d of disposables) d.dispose();
      selectionStore.clear();
    };
  }, [diffEditor, selected, prLocalId, renderSideBySide]);
}
