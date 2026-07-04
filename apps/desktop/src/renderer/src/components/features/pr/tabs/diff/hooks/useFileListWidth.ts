import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';

const DIFF_FILE_LIST_MIN = 180;
const DIFF_FILE_LIST_MAX = 560;
const DIFF_FILE_LIST_DEFAULT = 280;

/** Left file list width: localStorage-persisted + drag handle resize (clamped between MIN/MAX). */
export function useFileListWidth(): {
  fileListWidth: number;
  startFileListResize: (e: ReactMouseEvent) => void;
} {
  const [fileListWidth, setFileListWidth] = useState<number>(() => {
    const raw = localStorage.getItem('meebox.diffFileListWidth');
    const n = raw ? Number(raw) : DIFF_FILE_LIST_DEFAULT;
    return Math.min(
      DIFF_FILE_LIST_MAX,
      Math.max(DIFF_FILE_LIST_MIN, Number.isFinite(n) ? n : DIFF_FILE_LIST_DEFAULT),
    );
  });
  useEffect(() => {
    localStorage.setItem('meebox.diffFileListWidth', String(fileListWidth));
  }, [fileListWidth]);

  const startFileListResize = (e: ReactMouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = fileListWidth;
    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX;
      const next = Math.min(DIFF_FILE_LIST_MAX, Math.max(DIFF_FILE_LIST_MIN, startWidth + dx));
      setFileListWidth(next);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return { fileListWidth, startFileListResize };
}
