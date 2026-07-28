import { useEffect, useState } from 'react';
import { type editor as MonacoEditor } from 'monaco-editor';

/**
 * `renderSideBySide` on the toolbar is the user's *intent* (persisted toggle). Monaco auto-degrades side-by-side →
 * inline when the pane is too narrow (`useInlineViewWhenSpaceIsLimited`, on by default), leaving the intent `true`
 * while the actual layout is unified. Monaco reflects the real mode in the `.monaco-diff-editor` root node's
 * `side-by-side` class (removed when downgrading to inline).
 *
 * Anything that positions content by editor side — which inner editor a comment/draft zone, glyph dot, overview tick,
 * or reveal targets — must key off the **actual** mode, not the intent: in the auto-degraded state the original editor
 * is hidden, so an old-side item routed there by intent lands on an invisible editor ("missing position"). This
 * returns the actual mode: the intent AND the class being present.
 */
export function isActualSideBySide(
  diffEditor: MonacoEditor.IStandaloneDiffEditor,
  renderSideBySide: boolean,
): boolean {
  if (!renderSideBySide) return false;
  const el = diffEditor.getContainerDomNode().querySelector('.monaco-diff-editor');
  return el ? el.classList.contains('side-by-side') : true;
}

/**
 * Reactive {@link isActualSideBySide}: recomputes when Monaco's layout crosses the side-by-side ↔ inline breakpoint
 * (`onDidLayoutChange`) or the diff recomputes (`onDidUpdateDiff`). rAF-coalesced and deferred so the class is read
 * after Monaco has switched it (the layout event may precede the class flip). Returns the intent prop directly until
 * the editor is available.
 */
export function useActualRenderSideBySide(
  diffEditor: MonacoEditor.IStandaloneDiffEditor | null,
  renderSideBySide: boolean,
): boolean {
  const [actual, setActual] = useState(renderSideBySide);
  useEffect(() => {
    if (!diffEditor) {
      setActual(renderSideBySide);
      return;
    }
    const read = (): void => setActual(isActualSideBySide(diffEditor, renderSideBySide));
    read();
    let raf = 0;
    const schedule = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        read();
      });
    };
    // The original editor still emits layout changes as it collapses to / expands from hidden at the breakpoint;
    // onDidUpdateDiff covers the first async diff settling after a file switch.
    const layoutDisp = diffEditor.getOriginalEditor().onDidLayoutChange(schedule);
    const diffDisp = diffEditor.onDidUpdateDiff(schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      layoutDisp.dispose();
      diffDisp.dispose();
    };
  }, [diffEditor, renderSideBySide]);
  return actual;
}
