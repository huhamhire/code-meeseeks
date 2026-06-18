import { useEffect } from 'react';
import { invoke } from '../api';

/**
 * 全局外链跳转防护：所有 UGC 场景（评论 / PR 描述 / finding / chat 等）内的
 * `<a href="http(s)://">` 点击都走系统默认浏览器，不允许 Electron 在 app window 内直接跳转
 * 覆盖整个界面。capture 阶段 listener 先于 React onClick 跑。
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
