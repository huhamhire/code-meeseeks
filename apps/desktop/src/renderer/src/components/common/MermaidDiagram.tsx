import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useResolvedTheme } from '../../hooks/useTheme';

/**
 * Mermaid rendering: renders ```mermaid code blocks into SVG diagrams (Qodo `/describe` often generates architecture diagrams).
 *
 * - **Lazy load**: mermaid is large (includes d3 etc.), only `import('mermaid')` when a mermaid block actually
 *   appears and the component mounts, keeping it out of the entry bundle and adding no startup cost (same idea as Monaco lazy loading).
 * - **securityLevel: 'strict'**: content comes from AI / remote PR descriptions; under strict, mermaid escapes
 *   label text and disables click scripts, so the produced SVG is safe to inject.
 * - **Failure fallback**: on syntax errors / render exceptions, fall back to showing the original code block, so the source is readable even when the diagram fails.
 * - Theme follows the app dark / light switch (`dark` / `default`): mermaid theme is global state and does not go through CSS custom properties,
 *   so re-initialize with the current resolved theme before each render, and include the theme in the render effect deps to redraw on switch.
 */

// Declare only the minimal interface this component uses, avoiding import() type annotations (and decoupling from mermaid's internal types).
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

let mermaidLoader: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  // Reset the cache on failure: otherwise the rejected promise is cached forever, and later calls always get the same
  // failed result with no retry (the classic "cached Promise" trap).
  mermaidLoader ??= import('mermaid')
    .then((m) => {
      const mermaid = m.default as unknown as MermaidApi;
      // Theme is not fixed here: re-initialize with the current app theme before each render (see the component render effect).
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
      return mermaid;
    })
    .catch((e: unknown) => {
      mermaidLoader = null;
      throw e;
    });
  return mermaidLoader;
}

export function MermaidDiagram({ source }: { source: string }) {
  const { t } = useTranslation();
  // mermaid theme is global state and does not go through CSS custom properties: switches with the app resolved theme (dark 'dark' / light 'default').
  const mermaidTheme = useResolvedTheme() === 'light' ? 'default' : 'dark';
  // mermaid.render needs a unique id (it creates temporary DOM nodes internally); useId guarantees each instance is stably unique,
  // strip `:` (mermaid uses it as a DOM id / CSS selector, where the colon is invalid)
  const renderId = `mmd-${useId().replace(/:/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    void (async () => {
      try {
        const mermaid = await loadMermaid();
        // Re-initialize with the current theme before rendering (global state, idempotent): re-rendering after a theme switch swaps the color scheme.
        mermaid.initialize({ startOnLoad: false, theme: mermaidTheme, securityLevel: 'strict' });
        const out = await mermaid.render(renderId, source);
        if (!cancelled) setSvg(out.svg);
      } catch (e) {
        // Log once to aid debugging (syntax error / load failure); UI falls back to the original code block
        console.error('[mermaid] render failed', e);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, renderId, mermaidTheme]);

  if (failed) {
    // Fallback: keep the original mermaid source, at least it stays readable
    return (
      <pre className="mermaid-fallback">
        <code>{source}</code>
      </pre>
    );
  }
  if (svg === null) {
    return <div className="mermaid-loading muted">{t('mermaidDiagram.rendering')}</div>;
  }
  // SVG produced by mermaid strict mode has escaped untrusted content and is safe to inject. Click the diagram → modal preview.
  return (
    <>
      <div
        className="mermaid-diagram"
        role="button"
        tabIndex={0}
        title={t('mermaidDiagram.zoomHint')}
        onClick={() => setZoomed(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setZoomed(true);
          }
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {zoomed &&
        createPortal(
          <MermaidZoomModal
            // Rewrite the id (which appears in <style> selectors / arrow marker references) to avoid id collisions with the inline copy
            svgHtml={svg.replaceAll(renderId, `${renderId}-zoom`)}
            onClose={() => setZoomed(false)}
          />,
          document.body,
        )}
    </>
  );
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/**
 * mermaid modal preview: a preview area with a fixed solid background + a zoomable/draggable view.
 *
 * No longer manually measures the svg content and computes the scale — under the interaction of mermaid's svg
 * "width:100% / inline max-width / absolutely positioned container / transform", the rendered pixel size differs
 * between "at measurement" and "after paint", so a hand-computed fit is bound to be off. Instead let the browser
 * natively handle "fit": svg `width/height:100%` fills the preview area + `preserveAspectRatio`
 * (default xMidYMid meet) auto-scales proportionally and centers; zoom/drag just layer a transform on top.
 * - Default (scale=1): the diagram auto-fits the window and centers (native).
 * - Wheel zoom (anchored to the cursor), left-button drag pan, toolbar zoom in/out/reset, Esc / click backdrop to close.
 */
function MermaidZoomModal({ svgHtml, onClose }: { svgHtml: string; onClose: () => void }) {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  // scale=1 is the "native fit-to-window" baseline; zoom/pan layer on top of it.
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);

  const resetFit = (): void => {
    setScale(1);
    setTx(0);
    setTy(0);
  };

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Zoom anchored at (px,py) within the preview area: keep the point under the cursor fixed.
  const zoomAt = (px: number, py: number, factor: number): void => {
    const ns = clampScale(scale * factor);
    const k = ns / scale;
    setTx(px - (px - tx) * k);
    setTy(py - (py - ty) * k);
    setScale(ns);
  };

  const onWheel = (e: React.WheelEvent): void => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  };

  const zoomButton = (factor: number): void => {
    const stage = stageRef.current;
    if (!stage) return;
    const sr = stage.getBoundingClientRect();
    zoomAt(sr.width / 2, sr.height / 2, factor);
  };

  const onMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { x: e.clientX, y: e.clientY };
    const move = (ev: MouseEvent): void => {
      if (!drag.current) return;
      const dx = ev.clientX - drag.current.x;
      const dy = ev.clientY - drag.current.y;
      drag.current = { x: ev.clientX, y: ev.clientY };
      setTx((t) => t + dx);
      setTy((t) => t + dy);
    };
    const up = (): void => {
      drag.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div className="mermaid-zoom-overlay" role="presentation" onClick={onClose}>
      <div
        className="mermaid-zoom-dialog"
        role="presentation"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mermaid-zoom-toolbar">
          <span className="mermaid-zoom-scale">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            title={t('mermaidDiagram.zoomOut')}
            aria-label={t('mermaidDiagram.zoomOut')}
            onClick={() => zoomButton(1 / 1.2)}
          >
            −
          </button>
          <button
            type="button"
            title={t('mermaidDiagram.zoomIn')}
            aria-label={t('mermaidDiagram.zoomIn')}
            onClick={() => zoomButton(1.2)}
          >
            +
          </button>
          <button
            type="button"
            title={t('mermaidDiagram.fitWindow')}
            aria-label={t('mermaidDiagram.fitWindow')}
            onClick={resetFit}
          >
            ⤢
          </button>
          <button
            type="button"
            title={t('mermaidDiagram.closeEsc')}
            aria-label={t('common.close')}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div
          className="mermaid-zoom-stage"
          ref={stageRef}
          role="presentation"
          onWheel={onWheel}
          onMouseDown={onMouseDown}
        >
          <div
            className="mermaid-zoom-content"
            style={{
              transform: `translate(${String(tx)}px, ${String(ty)}px) scale(${String(scale)})`,
            }}
            dangerouslySetInnerHTML={{ __html: svgHtml }}
          />
        </div>
      </div>
    </div>
  );
}
