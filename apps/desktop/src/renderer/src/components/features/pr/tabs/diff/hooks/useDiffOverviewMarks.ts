import { useEffect } from 'react';
import { editor as MonacoEditorNs, type editor as MonacoEditor } from 'monaco-editor';
import type { DiffChangedFile } from '@meebox/ipc';
import type { LoadedContent } from '../diff-types';
import { isActualSideBySide } from './useActualRenderSideBySide';

// Add/change green, delete red (same color family as GitHub diff). diff marks go on the overview ruler's Left lane,
// separate from comment anchors (Right lane, see useCommentZones), so they don't overlap.
const ADDED_COLOR = '#3fb950';
const REMOVED_COLOR = '#f85149';

/**
 * Project diff add/delete/change onto the inner editor's built-in overview ruler (edit-mode style, single scrollbar ruler),
 * replacing the diff-specific renderOverviewRuler wide column (that one adds a separate column in side-by-side view, see DiffPane).
 *
 * - modified editor: add / change lines green; pure delete draws a red tick at the delete point
 * - original editor under side-by-side view: delete / change lines red
 *
 * Note: `renderSideBySide` is the user's toolbar-selected "side-by-side / unified" **intent**, while Monaco, when width is insufficient, will
 * automatically downgrade side-by-side to inline/unified layout (useInlineViewWhenSpaceIsLimited on by default), where the intent is still
 * side-by-side but the actual rendering is unified. If we draw the delete red mark to the original editor by intent, after downgrade original is invisible → red marks all lost,
 * scrollbar left with green only. So decide red-mark placement by the **actual render mode**: Monaco reflects the actual mode in the `.monaco-diff-editor`
 * root node's `side-by-side` class (removed when downgrading to inline), judge by that rather than the user intent prop.
 *
 * getLineChanges() only has a value after the async diff finishes; if the first frame already finished refresh directly, otherwise wait for onDidUpdateDiff. When the layout
 * switches side-by-side ↔ unified at a breakpoint (onDidLayoutChange) redraw red marks by the new mode (rAF-coalesced, read after the class switch stabilizes).
 */
export function useDiffOverviewMarks(opts: {
  diffEditor: MonacoEditor.IStandaloneDiffEditor | null;
  content: LoadedContent | null;
  selected: DiffChangedFile | null;
  renderSideBySide: boolean;
}): void {
  const { diffEditor, content, selected, renderSideBySide } = opts;
  useEffect(() => {
    if (!diffEditor || !content || !selected) return;
    const modifiedEditor = diffEditor.getModifiedEditor();
    const originalEditor = diffEditor.getOriginalEditor();
    const modCol = modifiedEditor.createDecorationsCollection([]);
    const origCol = originalEditor.createDecorationsCollection([]);

    const Lane = MonacoEditorNs.OverviewRulerLane;
    const deco = (
      startLine: number,
      endLine: number,
      color: string,
      position: number,
    ): MonacoEditor.IModelDeltaDecoration => ({
      range: { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn: 1 },
      options: { overviewRuler: { color, position } },
    });

    const refresh = (): void => {
      const changes = diffEditor.getLineChanges() ?? [];
      const sideBySide = isActualSideBySide(diffEditor, renderSideBySide);
      const modDecos: MonacoEditor.IModelDeltaDecoration[] = [];
      const origDecos: MonacoEditor.IModelDeltaDecoration[] = [];
      for (const c of changes) {
        const isInsert = c.originalEndLineNumber === 0; // pure add (no line on original side)
        const isDelete = c.modifiedEndLineNumber === 0; // pure delete (no line on modified side)
        // add / change: modified side modifiedStart..End marked green (Left lane)
        if (!isDelete) {
          modDecos.push(
            deco(c.modifiedStartLineNumber, c.modifiedEndLineNumber, ADDED_COLOR, Lane.Left),
          );
        }
        // mark the "removed part" of delete / change red:
        if (!isInsert) {
          if (sideBySide) {
            // side-by-side: red drawn on the left original editor's built-in ruler (Left lane), doesn't interfere with the right-side green
            origDecos.push(
              deco(c.originalStartLineNumber, c.originalEndLineNumber, REMOVED_COLOR, Lane.Left),
            );
          } else {
            // unified view (including downgraded from side-by-side): original editor invisible, red tick and green both drawn on modified Left lane.
            // Deleted lines under unified are view zones (no model line number), can only be marked at the delete point modifiedStartLineNumber;
            // when a change block's same line is both green and red, green covers red → change block shows green, pure-delete line (no green) shows red.
            const line = Math.max(1, c.modifiedStartLineNumber);
            modDecos.push(deco(line, line, REMOVED_COLOR, Lane.Left));
          }
        }
      }
      modCol.set(modDecos);
      origCol.set(origDecos);
    };

    if (diffEditor.getLineChanges() != null) refresh();
    const disp = diffEditor.onDidUpdateDiff(refresh);
    // When width crosses a breakpoint causing side-by-side ↔ unified switch, red-mark placement changes accordingly → redraw. The layout event may precede Monaco switching
    // the `side-by-side` class, so use rAF to defer reading the class to the end of this frame; rAF also coalesces high-frequency events during resize.
    let raf = 0;
    const scheduleRefresh = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        refresh();
      });
    };
    const layoutDisp = originalEditor.onDidLayoutChange(scheduleRefresh);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      disp.dispose();
      layoutDisp.dispose();
      try {
        modCol.clear();
        origCol.clear();
      } catch {
        /* editor disposed */
      }
    };
  }, [diffEditor, content, selected, renderSideBySide]);
}
