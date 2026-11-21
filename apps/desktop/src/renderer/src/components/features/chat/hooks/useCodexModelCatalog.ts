import { useEffect, useState } from 'react';
import { invoke } from '../../../../api';

export function useCodexModelCatalog(enabled: boolean) {
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoading(true);
    setError(false);
    void (async () => {
      const cached = await invoke('codex:models', { cachedOnly: true }).catch(() => []);
      if (live && cached.length > 0) setModels(cached);
      return invoke('codex:models', {});
    })().then(
      (items) => {
        if (!live) return;
        setModels(items);
        setLoading(false);
      },
      () => {
        if (!live) return;
        setError(true);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return { models, loading, error };
}
