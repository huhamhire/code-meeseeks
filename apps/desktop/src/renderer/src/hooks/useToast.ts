import { useCallback, useEffect, useState } from 'react';

/**
 * Action-level toast (shown when a remote action such as approve / merge fails, as opposed to fatalError's full-screen error).
 * The key uses a random number: the same text triggered consecutively can still reset the auto-dismiss timer; auto-dismisses after 6s.
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
    // Depend only on key: re-rendering the same toast doesn't reset the timer, only a new toast (key changes) resets it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast?.key]);
  return { toast, notifyError, dismiss };
}
