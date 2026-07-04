import { useEffect, useState } from 'react';
import type { UpdateCheckResult } from '@meebox/shared';
import { invoke, subscribe } from '../api';

/**
 * Version update notice (main is the single source of truth): on mount, hydrate the cached result (a new version found via the settings-page manual check / scheduled check
 * isn't lost when the window remounts), then subscribe to subsequent broadcasts. Also includes a dev debug hook — the console can dispatch
 * `meebox:debug-update` (detail may carry latestVersion / null to clear) to simulate "new version found" and verify the status bar chip.
 */
export function useUpdateNotice(): UpdateCheckResult | null {
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  useEffect(() => {
    void invoke('app:getUpdateStatus', undefined).then((info) => {
      if (info) setUpdateInfo(info);
    });
    return subscribe('app:updateAvailable', (info) => setUpdateInfo(info));
  }, []);
  useEffect(() => {
    const onDebug = (e: Event): void => {
      const d = (e as CustomEvent<Partial<UpdateCheckResult> | null>).detail;
      setUpdateInfo(
        d === null
          ? null
          : {
              ok: true,
              hasUpdate: true,
              currentVersion: '0.0.0',
              latestVersion: '9.9.9',
              url: 'https://github.com/huhamhire/code-meeseeks/releases/latest',
              ...d,
            },
      );
    };
    window.addEventListener('meebox:debug-update', onDebug);
    return () => window.removeEventListener('meebox:debug-update', onDebug);
  }, []);
  return updateInfo;
}
