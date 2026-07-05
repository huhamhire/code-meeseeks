import { useState, type RefObject } from 'react';

/**
 * Drag the textarea's top edge to resize its height. Does not use CSS `resize: vertical` (its handle is at the bottom-right and only grows when dragged down,
 * but the input is pinned to the panel bottom and visually expands upward, which is counterintuitive); instead draws a custom handle on the top edge, dragging up = grow.
 * Bounds match css min-height (2 lines) / max-height (8 lines); when height is null, no inline style is written.
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
    // Matches css tokens: $fs-md=13 * $lh-normal=1.4 = 18.2 px/line; $space-3=6 px padding top+bottom = 12 px
    const MIN = Math.round(13 * 1.4 * 2 + 12);
    const MAX = Math.round(13 * 1.4 * 8 + 12);
    const onMove = (ev: MouseEvent): void => {
      // Drag up dy < 0 → height increases; drag down is the reverse
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
