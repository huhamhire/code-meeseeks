import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { editor as MonacoEditorNs, type editor as MonacoEditor } from 'monaco-editor';
import { remapOldByLineToModified } from './line-mapping';

/**
 * Generic Monaco inline view-zone mount mechanism: the inline comment zone and draft zone share one pipeline —
 * two-layer `dom`/`inner` structure, `stopPropagation` event takeover, width `applyInnerLayout`, horizontal-scroll
 * `translateX` sync, height write-back via `ResizeObserver`, mapping the old side to the corresponding editor per view,
 * `removeZone` / `unmount` cleanup. The differences (which events to intercept, initial height estimation, what component
 * to render) are injected via options.
 *
 * Returns a cleanup function (called in the effect's teardown). The comment zone's extra glyph decorations are not managed
 * here (the caller useCommentZones creates / clears them itself).
 */
export interface MountInlineZonesOptions<T> {
  diffEditor: MonacoEditor.IStandaloneDiffEditor;
  renderSideBySide: boolean;
  /** Old-side (deleted / base-side context lines) buckets: key = line number */
  oldByLine: Map<number, T[]>;
  /** New-side (added / head-side context lines) buckets: key = line number */
  newByLine: Map<number, T[]>;
  /** Class of the monaco wrapper dom ('monaco-comment-zone' / 'monaco-draft-zone') */
  zoneClassName: string;
  /** Class of the real visual container inner ('monaco-comment-zone-inner' / 'monaco-draft-zone-inner') */
  innerClassName: string;
  /** Set of events stopPropagation takes over on dom + inner (drafts include keydown/wheel etc., comments only mouse-click kinds) */
  stopEvents: readonly string[];
  /** Initial zone height (px) estimation; lineHeight is monaco's current line height */
  initialHeight: (items: T[], lineHeight: number) => number;
  /** Render the zone content (React node) */
  render: (items: T[]) => ReactNode;
}

interface ZoneRef {
  editor: MonacoEditor.ICodeEditor;
  zoneId: string;
  root: Root;
  disposers: Array<() => void>;
}

export function mountInlineZones<T>(opts: MountInlineZonesOptions<T>): () => void {
  const {
    diffEditor,
    renderSideBySide,
    oldByLine,
    newByLine,
    zoneClassName,
    innerClassName,
    stopEvents,
    initialHeight,
    render,
  } = opts;

  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  const zoneRefs: ZoneRef[] = [];

  const addZonesFor = (editorInst: MonacoEditor.ICodeEditor, byLine: Map<number, T[]>): void => {
    const lineHeight = editorInst.getOption(MonacoEditorNs.EditorOption.lineHeight);
    editorInst.changeViewZones((accessor) => {
      for (const [line, items] of byLine) {
        // Two-layer structure: dom is the monaco wrapper (monaco writes height inline directly onto it),
        // inner is the real visual container not controlled by monaco → inner.offsetHeight is the true content height.
        const dom = document.createElement('div');
        dom.className = zoneClassName;

        // Classic Monaco view zone pitfall: the editor's built-in mousedown listener treats the whole zone area as
        // an "editor mouse target" and swallows events bubbling to the DOM → the zone's textarea gets no focus, buttons
        // don't respond to clicks. stopPropagation a set of key events on the dom container so monaco no longer takes over
        // user input within the zone. **Must be the bubble phase** (third arg omitted / false): intercepting in the capture
        // phase would block before the event reaches button/textarea, so React onClick / onKeyDown never fire. The bubble
        // phase lets the target's React handler fire first, then stops the bubble to the editor.
        const stopAll = (e: Event): void => e.stopPropagation();
        for (const evt of stopEvents) {
          dom.addEventListener(evt, stopAll);
        }

        const inner = document.createElement('div');
        inner.className = innerClassName;
        dom.appendChild(inner);

        const root = createRoot(inner);
        root.render(render(items));

        const initialPx = initialHeight(items, lineHeight);
        const zoneObj: MonacoEditor.IViewZone = {
          afterLineNumber: line,
          heightInPx: initialPx,
          domNode: dom,
        };
        const zoneId = accessor.addZone(zoneObj);

        // Height sync: directly mutate zoneObj.heightInPx + layoutZone(id). removeZone+addZone called every frame
        // during textarea drag-resize causes zone-rebuild jitter. layoutZone is a lightweight operation; mutate
        // heightInPx first then layoutZone to let monaco recompute the viewModel whitespace.
        // Measure with inner.offsetHeight (dom's height is hard-set by monaco, so offsetHeight would self-loop).
        const syncHeight = (): void => {
          const next = inner.offsetHeight;
          if (next <= 0) return;
          if (Math.abs(next - (zoneObj.heightInPx ?? 0)) < 1) return;
          zoneObj.heightInPx = next;
          try {
            editorInst.changeViewZones((acc) => {
              acc.layoutZone(zoneId);
            });
          } catch {
            /* editor disposed */
          }
        };
        // ResizeObserver tracks inner height changes (read↔edit switch, textarea resize, async loading of embedded images,
        // nested comment expansion). requestAnimationFrame avoids the "sync layout in the callback re-triggers RO" loop.
        const ro = new ResizeObserver(() => {
          requestAnimationFrame(syncHeight);
        });
        ro.observe(inner);
        // Sync at multiple points as a fallback covering layout jitter / React multi-phase render
        requestAnimationFrame(syncHeight);
        setTimeout(syncHeight, 50);
        setTimeout(syncHeight, 200);

        // Width strategy: derive the inner width from Monaco's own layout info, not from getBoundingClientRect. The
        // editor's DOM rect is unreliable during init / a file switch (it can report a transient too-wide box until a
        // manual resize forces a remeasure), whereas getLayoutInfo() is Monaco's authoritative post-layout geometry and
        // is correct as soon as the editor has laid out. The zone dom sits at the content origin (after the gutter) and
        // is pinned in the viewport via translateX(scrollLeft), so the inner spans the content area minus the right
        // scrollbar: width = layoutInfo.width - contentLeft - verticalScrollbarWidth.
        const editorDomNode = editorInst.getDomNode();
        // Returns the width applied to inner (px), or -1 when the editor isn't laid out yet (nothing applied).
        const applyInnerLayout = (): number => {
          const li = editorInst.getLayoutInfo();
          const w = li.width - li.contentLeft - (li.verticalScrollbarWidth ?? 0);
          if (w <= 0) return -1; // editor not laid out yet, wait for the next trigger
          inner.style.marginLeft = '0';
          inner.style.width = `${w}px`;
          inner.style.maxWidth = `${w}px`;
          return w;
        };
        // Settle loop instead of fixed one-shot timers: on a file switch / first Monaco init the editor geometry
        // stabilizes at an unpredictable time (font measurement, async diff compute, hideUnchangedRegions collapse,
        // loading-overlay removal). Fixed timers can all fire before the final layout, leaving the box measured too
        // wide (spilling into the chat pane) until a manual resize. Re-apply on animation frames until the width
        // repeats across two consecutive frames (stable) or a generous cap elapses; the permanent observers below
        // then handle any later change. rAF (not setTimeout) so measurement reads a painted layout.
        let settleRaf = 0;
        let settleStart = -1;
        let prevWidth = -1;
        const settle = (now: number): void => {
          if (settleStart < 0) settleStart = now;
          const w = applyInnerLayout();
          // Stable: a positive width unchanged from the previous frame. Keep going while it's still moving or not
          // yet laid out, but never past the cap (covers a layout that legitimately never fully settles).
          if ((w > 0 && w === prevWidth) || now - settleStart > 1500) {
            settleRaf = 0;
            return;
          }
          prevWidth = w;
          settleRaf = requestAnimationFrame(settle);
        };
        applyInnerLayout(); // synchronous first apply avoids a one-frame flash at full width
        settleRaf = requestAnimationFrame(settle);
        // Dual trigger: onDidLayoutChange (geometry change) + ResizeObserver watching the editor DOM (window / splitter
        // resize), non-overlapping coverage; onDidUpdateDiff (after a file switch the layout still changes while the diff is computed, stabilizing only once done).
        const layoutDisp = editorInst.onDidLayoutChange(applyInnerLayout);
        const diffDisp = diffEditor.onDidUpdateDiff(() => requestAnimationFrame(applyInnerLayout));
        const editorRO = editorDomNode
          ? new ResizeObserver(() => requestAnimationFrame(applyInnerLayout))
          : null;
        if (editorDomNode && editorRO) editorRO.observe(editorDomNode);

        // Horizontal-scroll sync: the monaco view zone dom inside .lines-content shifts left along with scrollLeft
        // (after horizontal scroll the box gets clipped out of the viewport). Adding transform translateX(scrollLeft)
        // to inner cancels it out, so the box sticks at its relative position within the viewport (consistent with Bitbucket / GitHub inline comments).
        const applyScroll = (): void => {
          inner.style.transform = `translateX(${editorInst.getScrollLeft()}px)`;
        };
        applyScroll();
        const scrollDisp = editorInst.onDidScrollChange(applyScroll);

        // Also stopPropagation on inner (two-layer defense). **Must be after createRoot** — otherwise React 18's event
        // delegation initialization order on inner is affected, causing onClick not to fire (clicking the cancel button does nothing).
        for (const evt of stopEvents) {
          inner.addEventListener(evt, stopAll);
        }

        zoneRefs.push({
          editor: editorInst,
          zoneId,
          root,
          // Disconnect ResizeObserver + dispose listeners first, then unmount root, to avoid the DOM height collapse
          // caused by unmount triggering the observer callback + a layoutZone(disposed editor) error.
          disposers: [
            () => ro.disconnect(),
            () => layoutDisp.dispose(),
            () => diffDisp.dispose(),
            () => editorRO?.disconnect(),
            () => scrollDisp.dispose(),
            () => {
              if (settleRaf) cancelAnimationFrame(settleRaf);
            },
          ],
        });
      }
    });
  };

  // Side-by-side view: old side mounts on the original editor; unified view: the original editor is hidden, old side
  // mounts on the modified editor's corresponding line (deleted lines are modified's view zone in the unified view, mapping the original line number to modified afterLineNumber per diff line change).
  if (renderSideBySide) {
    addZonesFor(originalEditor, oldByLine);
  } else if (oldByLine.size > 0) {
    addZonesFor(
      modifiedEditor,
      remapOldByLineToModified(diffEditor.getLineChanges() ?? [], oldByLine),
    );
  }
  addZonesFor(modifiedEditor, newByLine);

  return () => {
    try {
      originalEditor.changeViewZones((accessor) => {
        for (const z of zoneRefs) {
          if (z.editor === originalEditor) accessor.removeZone(z.zoneId);
        }
      });
      modifiedEditor.changeViewZones((accessor) => {
        for (const z of zoneRefs) {
          if (z.editor === modifiedEditor) accessor.removeZone(z.zoneId);
        }
      });
    } catch {
      /* editor disposed */
    }
    for (const z of zoneRefs) {
      for (const dispose of z.disposers) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
    }
    // React 18+: unmount can't be called synchronously in the render phase, defer it to a microtask
    queueMicrotask(() => {
      for (const z of zoneRefs) {
        try {
          z.root.unmount();
        } catch {
          /* ignore */
        }
      }
    });
  };
}
