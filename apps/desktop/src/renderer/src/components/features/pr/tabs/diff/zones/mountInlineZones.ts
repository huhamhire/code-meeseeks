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
 * Two entry points sharing the same internals:
 *  - {@link createInlineZones} returns a persistent controller whose `update(content)` **reconciles** zones by
 *    `(side, line)` key: an unchanged key re-renders its existing React root in place (preserving the zone's React
 *    state, e.g. an in-progress inline reply/edit that must survive a comments refresh / poll), a new key mounts a
 *    fresh zone, a vanished key is removed. Use this when the zone content changes independently of the editor/file.
 *  - {@link mountInlineZones} is the original one-shot form (create + populate once, teardown on cleanup), kept for
 *    callers that rebuild their whole zone set per effect run (the draft zones).
 *
 * The comment zone's extra glyph decorations are not managed here (the caller useCommentZones creates / clears them itself).
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

/** Structural options for {@link createInlineZones}: everything that identifies where/how zones mount, minus the content. */
export interface CreateInlineZonesOptions {
  diffEditor: MonacoEditor.IStandaloneDiffEditor;
  renderSideBySide: boolean;
  zoneClassName: string;
  innerClassName: string;
  stopEvents: readonly string[];
}

/** Per-`update` content: the line buckets + how to size and render each zone. */
export interface InlineZonesContent<T> {
  oldByLine: Map<number, T[]>;
  newByLine: Map<number, T[]>;
  initialHeight: (items: T[], lineHeight: number) => number;
  render: (items: T[]) => ReactNode;
}

export interface InlineZonesController<T> {
  /** Reconcile the mounted zones to match `content`, preserving the React root (and its state) of any unchanged key. */
  update(content: InlineZonesContent<T>): void;
  /** Remove every zone and unmount its root. */
  dispose(): void;
}

interface ZoneRef {
  /** Stable reconciliation key: `new:<modifiedLine>` or `old:<line>` (side-by-side old line, or the remapped modified line in unified). */
  key: string;
  editor: MonacoEditor.ICodeEditor;
  zoneId: string;
  /** The afterLineNumber this zone currently sits at; a change means the anchor moved → remove + re-add rather than re-render in place. */
  afterLine: number;
  root: Root;
  disposers: Array<() => void>;
}

export function createInlineZones<T>(opts: CreateInlineZonesOptions): InlineZonesController<T> {
  const { diffEditor, renderSideBySide, zoneClassName, innerClassName, stopEvents } = opts;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  // Live registry keyed by the stable `(side, line)` key; persists across update() calls so unchanged zones keep their root.
  const zones = new Map<string, ZoneRef>();

  // Create ONE zone. **Must be called inside editorInst.changeViewZones(accessor => ...)**, so the caller batches
  // adds/removes. Registers the resulting ZoneRef into `zones` under `key`.
  const createZone = (
    accessor: MonacoEditor.IViewZoneChangeAccessor,
    editorInst: MonacoEditor.ICodeEditor,
    key: string,
    afterLine: number,
    items: T[],
    content: InlineZonesContent<T>,
  ): void => {
    const { render, initialHeight } = content;
    const lineHeight = editorInst.getOption(MonacoEditorNs.EditorOption.lineHeight);
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
      afterLineNumber: afterLine,
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

    zones.set(key, {
      key,
      editor: editorInst,
      zoneId,
      afterLine,
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
  };

  // Dispose one zone's observers/listeners now, then unmount its root on a microtask (React 18+ forbids a synchronous
  // unmount during render; deferring also lets the removeZone above settle first).
  const disposeZone = (ref: ZoneRef): void => {
    for (const dispose of ref.disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
    queueMicrotask(() => {
      try {
        ref.root.unmount();
      } catch {
        /* ignore */
      }
    });
  };

  // Compute the desired zone set (key → placement) for `content`, mirroring the original mount's side routing:
  // new-side on the modified editor; old-side on the original editor (side-by-side) or remapped onto the modified
  // editor (unified, where the original editor is hidden).
  const computeDesired = (
    content: InlineZonesContent<T>,
  ): Map<string, { editor: MonacoEditor.ICodeEditor; afterLine: number; items: T[] }> => {
    const desired = new Map<
      string,
      { editor: MonacoEditor.ICodeEditor; afterLine: number; items: T[] }
    >();
    for (const [line, items] of content.newByLine) {
      desired.set(`new:${line}`, { editor: modifiedEditor, afterLine: line, items });
    }
    if (renderSideBySide) {
      for (const [line, items] of content.oldByLine) {
        desired.set(`old:${line}`, { editor: originalEditor, afterLine: line, items });
      }
    } else if (content.oldByLine.size > 0) {
      const remapped = remapOldByLineToModified(diffEditor.getLineChanges() ?? [], content.oldByLine);
      for (const [line, items] of remapped) {
        desired.set(`old:${line}`, { editor: modifiedEditor, afterLine: line, items });
      }
    }
    return desired;
  };

  const update = (content: InlineZonesContent<T>): void => {
    const desired = computeDesired(content);

    // Removals: a key that vanished, or whose editor/anchor line moved (the latter can't be re-rendered in place →
    // drop and re-add below). Batch removeZone per editor inside changeViewZones, then dispose each ref.
    const toRemove: ZoneRef[] = [];
    for (const ref of zones.values()) {
      const d = desired.get(ref.key);
      if (!d || d.editor !== ref.editor || d.afterLine !== ref.afterLine) toRemove.push(ref);
    }
    if (toRemove.length > 0) {
      for (const editorInst of [originalEditor, modifiedEditor]) {
        const rs = toRemove.filter((r) => r.editor === editorInst);
        if (rs.length === 0) continue;
        try {
          editorInst.changeViewZones((acc) => {
            for (const r of rs) acc.removeZone(r.zoneId);
          });
        } catch {
          /* editor disposed */
        }
      }
      for (const r of toRemove) {
        zones.delete(r.key);
        disposeZone(r);
      }
    }

    // Re-renders (in place, preserving React state) for surviving keys; collect brand-new keys to add.
    const toAdd: Array<{
      editor: MonacoEditor.ICodeEditor;
      key: string;
      afterLine: number;
      items: T[];
    }> = [];
    for (const [key, d] of desired) {
      const existing = zones.get(key);
      if (existing) {
        existing.root.render(content.render(d.items));
      } else {
        toAdd.push({ editor: d.editor, key, afterLine: d.afterLine, items: d.items });
      }
    }
    if (toAdd.length > 0) {
      for (const editorInst of [originalEditor, modifiedEditor]) {
        const as = toAdd.filter((a) => a.editor === editorInst);
        if (as.length === 0) continue;
        editorInst.changeViewZones((acc) => {
          for (const a of as) createZone(acc, editorInst, a.key, a.afterLine, a.items, content);
        });
      }
    }
  };

  const dispose = (): void => {
    const all = [...zones.values()];
    zones.clear();
    try {
      originalEditor.changeViewZones((accessor) => {
        for (const z of all) {
          if (z.editor === originalEditor) accessor.removeZone(z.zoneId);
        }
      });
      modifiedEditor.changeViewZones((accessor) => {
        for (const z of all) {
          if (z.editor === modifiedEditor) accessor.removeZone(z.zoneId);
        }
      });
    } catch {
      /* editor disposed */
    }
    for (const z of all) {
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
      for (const z of all) {
        try {
          z.root.unmount();
        } catch {
          /* ignore */
        }
      }
    });
  };

  return { update, dispose };
}

/**
 * One-shot form (create + populate once, teardown on cleanup). Behaviourally identical to the pre-controller
 * mechanism, kept for callers (the draft zones) that rebuild their entire zone set on each effect run. Returns a
 * cleanup function to call in the effect's teardown.
 */
export function mountInlineZones<T>(opts: MountInlineZonesOptions<T>): () => void {
  const controller = createInlineZones<T>({
    diffEditor: opts.diffEditor,
    renderSideBySide: opts.renderSideBySide,
    zoneClassName: opts.zoneClassName,
    innerClassName: opts.innerClassName,
    stopEvents: opts.stopEvents,
  });
  controller.update({
    oldByLine: opts.oldByLine,
    newByLine: opts.newByLine,
    initialHeight: opts.initialHeight,
    render: opts.render,
  });
  return () => controller.dispose();
}
