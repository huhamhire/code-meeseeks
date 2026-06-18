import { useCallback, useEffect, useState } from 'react';

/**
 * 操作级 toast（审批 / 合并等远端动作失败时提示，区别于 fatalError 整屏报错）。
 * key 用随机数：同样文案连续触发也能重置自动消失计时器；6s 后自动消失。
 */
export function useToast(): {
  toast: { text: string; key: number } | null;
  notifyError: (text: string) => void;
  dismiss: () => void;
} {
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null);
  const notifyError = useCallback((text: string): void => {
    setToast({ text, key: Math.random() });
  }, []);
  const dismiss = useCallback((): void => setToast(null), []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
    // 仅依赖 key：同一 toast 重渲不重置计时，新 toast (key 变) 才重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast?.key]);
  return { toast, notifyError, dismiss };
}
