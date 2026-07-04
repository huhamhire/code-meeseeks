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

        // Width + position strategy (aligned with Bitbucket / GitHub inline comments): use BoundingClientRect to get the
        // browser's actual render coordinates (clientWidth / layoutInfo.width occasionally exceed the editor's visual
        // boundary in monaco inline view, observed the comment box spilling into the ChatPane area). inner starts at the
        // dom origin and extends at most to the editor's visual right boundary - verticalScrollbar. When dom isn't yet
        // attached to the DOM tree rect.width=0, fall back to the editor's left boundary.
        const editorDomNode = editorInst.getDomNode();
        const applyInnerLayout = (): void => {
          if (!editorDomNode) return;
          const editorRect = editorDomNode.getBoundingClientRect();
          if (editorRect.width <= 0) return; // editor not laid out yet, wait for the next trigger
          const domRect = dom.getBoundingClientRect();
          const sbW = editorInst.getLayoutInfo().verticalScrollbarWidth ?? 0;
          const innerLeft = domRect.width > 0 ? domRect.left : editorRect.left;
          const innerRight = editorRect.right - sbW;
          const w = Math.max(0, innerRight - innerLeft);
          if (w > 0) {
            inner.style.marginLeft = '0';
            inner.style.width = `${w}px`;
            inner.style.maxWidth = `${w}px`;
          }
        };
        applyInnerLayout();
        // Multi-point fallback: on file switch + autoEdit jump, monaco is still computing the diff / the file mount isn't
        // done, and getBoundingClientRect gives a non-stable layout (observed the box width blowing out when jumping to a new file, recovering after resize).
        requestAnimationFrame(applyInnerLayout);
        setTimeout(applyInnerLayout, 50);
        setTimeout(applyInnerLayout, 200);
        setTimeout(applyInnerLayout, 500);
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
