import { useState, type RefObject } from 'react';

/**
 * textarea 顶边拖拽调高。不用 CSS `resize: vertical`（handle 在右下角、向下拖才放大，
 * 但 input 钉在面板底部、视觉是向上扩展，反直觉）；改顶边自绘 handle，向上拖 = 放大。
 * 边界跟 css min-height(2 行) / max-height(5 行) 一致；height 为 null 时不写 inline style。
 */
export function useTextareaAutosizeDrag(textareaRef: RefObject<HTMLTextAreaElement | null>): {
  textareaHeightPx: number | null;
  handleTextareaResizeStart: (e: React.MouseEvent) => void;
} {
  const [textareaHeightPx, setTextareaHeightPx] = useState<number | null>(null);
  const handleTextareaResizeStart = (e: React.MouseEvent): void => {
    e.preventDefault();
    const el = textareaRef.current;
    if (!el) return;
    const startY = e.clientY;
    const startHeight = el.getBoundingClientRect().height;
    // 跟 css token: $fs-md=13 * $lh-normal=1.4 = 18.2 px/line；$space-3=6 px padding 上下 = 12 px
    const MIN = Math.round(13 * 1.4 * 2 + 12);
    const MAX = Math.round(13 * 1.4 * 5 + 12);
    const onMove = (ev: MouseEvent): void => {
      // 上拖 dy < 0 → 高度增加；下拖反之
      const dy = ev.clientY - startY;
      const next = Math.min(MAX, Math.max(MIN, startHeight - dy));
      setTextareaHeightPx(next);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };
  return { textareaHeightPx, handleTextareaResizeStart };
}
