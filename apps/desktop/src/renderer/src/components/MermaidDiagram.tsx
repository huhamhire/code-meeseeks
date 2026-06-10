import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

/**
 * Mermaid 渲染：把 ```mermaid 代码块渲染成 SVG 图（Qodo `/describe` 常生成架构图）。
 *
 * - **懒加载**：mermaid 体积大（含 d3 等），仅当真正出现 mermaid 块、组件挂载时才
 *   `import('mermaid')`，不进入口包、不增加启动成本（与 Monaco 懒加载同思路）。
 * - **securityLevel: 'strict'**：内容来自 AI / 远端 PR 描述，strict 下 mermaid 转义
 *   标签文本、禁用点击脚本，产出的 SVG 可安全注入。
 * - **失败回退**：语法错 / 渲染异常时回退展示原始代码块，图画错也能看源码。
 * - 主题 `dark`，与应用深色界面一致。
 */

// 仅声明本组件用到的最小接口，避免 import() 类型注解（且与 mermaid 内部类型解耦）。
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

let mermaidLoader: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  // 失败时重置缓存：否则 rejected promise 被永久缓存，后续调用永远拿到同一个失败结果、
  // 无法重试（典型「缓存 Promise」陷阱）。
  mermaidLoader ??= import('mermaid')
    .then((m) => {
      const mermaid = m.default as unknown as MermaidApi;
      mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
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
  // mermaid.render 需要唯一 id（内部建临时 DOM 节点）；useId 保证每个实例稳定唯一，
  // 去掉 `:`（mermaid 用作 DOM id / CSS 选择器，冒号非法）
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
        const out = await mermaid.render(renderId, source);
        if (!cancelled) setSvg(out.svg);
      } catch (e) {
        // 记一次日志便于排查（语法错 / 加载失败）；UI 回退到原始代码块
        console.error('[mermaid] render failed', e);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, renderId]);

  if (failed) {
    // 回退：保留原始 mermaid 源码，至少可读
    return (
      <pre className="mermaid-fallback">
        <code>{source}</code>
      </pre>
    );
  }
  if (svg === null) {
    return <div className="mermaid-loading muted">{t('mermaidDiagram.rendering')}</div>;
  }
  // mermaid strict 模式产出的 SVG 已转义不可信内容，可安全注入。点击图表 → 模态预览。
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
            // 重写 id（含 <style> 选择器 / 箭头 marker 引用），避免与内联副本同 id 冲突
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
 * mermaid 模态预览：固定纯色背景的预览区 + 可缩放/拖拽视图。
 *
 * 不再手动测量 svg 内容并算缩放 —— mermaid 的 svg 在「width:100% / 内联 max-width / 绝对定位
 * 容器 / transform」相互作用下，渲染像素尺寸在「测量时」与「绘制后」并不一致，手算 fit 必然偏差。
 * 改为让浏览器原生处理「适应」：svg `width/height:100%` 充满预览区 + `preserveAspectRatio`
 * （默认 xMidYMid meet）自动等比缩放并居中；缩放/拖拽只是在其上叠加一层 transform。
 * - 默认（scale=1）：图自动适应窗口、居中（原生）。
 * - 滚轮缩放（锚定光标）、左键拖拽平移、工具栏放大/缩小/复位、Esc / 点遮罩关闭。
 */
function MermaidZoomModal({ svgHtml, onClose }: { svgHtml: string; onClose: () => void }) {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  // scale=1 即「原生适应窗口」基准；缩放/平移在其上叠加。
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);

  const resetFit = (): void => {
    setScale(1);
    setTx(0);
    setTy(0);
  };

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 以预览区内 (px,py) 为锚点缩放：保持光标下的点不动。
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
