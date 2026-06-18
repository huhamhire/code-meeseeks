import { useEffect, useState } from 'react';
import type { UpdateCheckResult } from '@meebox/shared';
import { invoke, subscribe } from '../api';

/**
 * 版本更新提示（main 为单一真相源）：挂载时水合已缓存结果（设置页手动检查 / 定时检查到的新版
 * 不因窗口重挂载而丢失），再订阅后续广播。另含 dev 调试钩子——控制台 dispatch
 * `meebox:debug-update`（detail 可带 latestVersion / 为 null 清除）模拟「发现新版」验证状态栏 chip。
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
