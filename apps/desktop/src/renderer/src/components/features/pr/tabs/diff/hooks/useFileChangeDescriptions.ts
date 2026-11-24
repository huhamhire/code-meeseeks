import { useEffect, useState } from 'react';
import type { FileChangeDescription, StoredPullRequest } from '@meebox/shared';
import { invoke, subscribe } from '../../../../../../api';

export function useFileChangeDescriptions(
  pr: StoredPullRequest,
  range: { base: string; head: string } | null,
  commit: boolean,
): ReadonlyMap<string, FileChangeDescription> | undefined {
  const localId = pr.localId;
  const base = range?.base ?? pr.targetRef.sha;
  const head = range?.head ?? pr.sourceRef.sha;
  const key =
    base && head && (!commit || range) ? `${localId}|${base}|${head}|${String(commit)}` : null;
  const [result, setResult] = useState<{
    key: string;
    files: ReadonlyMap<string, FileChangeDescription>;
  } | null>(null);

  useEffect(() => {
    if (!key) return;
    let revision = 0;
    const load = async () => {
      const request = ++revision;
      try {
        const descriptions = await invoke('pragent:fileChangeDescriptions', {
          localId,
          base,
          head,
          commit,
        });
        if (request !== revision) return;
        setResult({ key, files: new Map(descriptions.map((file) => [file.path, file])) });
      } catch {
        if (request === revision) setResult(null);
      }
    };
    const unsubscribe = subscribe('pragent:fileChangeDescriptionsChanged', (ev) => {
      if (ev.localId === localId) void load();
    });
    void load();
    return () => {
      revision += 1;
      unsubscribe();
    };
  }, [key, localId, base, head, commit]);

  return result?.key === key ? result.files : undefined;
}
