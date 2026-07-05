import { useEffect } from 'react';
import { invoke } from '../api';

/**
 * Global external link navigation guard: clicks on `<a href="http(s)://">` in any UGC scenario (comments / PR
 * description / finding / chat, etc.) all go through the system default browser; Electron is not allowed to navigate
 * directly within the app window and cover the entire UI. The capture-phase listener runs before React onClick.
 */
export function useExternalLinkGuard(): void {
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      const target = (e.target as HTMLElement | null)?.closest?.('a[href]');
      if (!(target instanceof HTMLAnchorElement)) return;
      const href = target.getAttribute('href');
      if (!href || !/^https?:\/\//.test(href)) return;
      e.preventDefault();
      e.stopPropagation();
      void invoke('app:openExternal', { url: href });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
}
