import { useEffect } from 'react';
import type { Config, StoredPullRequest } from '@meebox/shared';
import { invoke } from '../api';

/**
 * macOS dock 角标同步：把活跃 PR「@我 / 回复我」待回应总数推给主进程落到 dock 图标。角标无独立开关——随通知
 * 总开关默认启用，关闭则置 0 清除；非 macOS 直接跳过（主进程也仅在 macOS 落地）。随 PR 列表 / 通知配置变化
 * 重算并推送。各 PR 计数已在 poll 端封顶 10，故总数自带上界。
 */
export function useDockBadge({
  prs,
  platform,
  notifications,
}: {
  prs: StoredPullRequest[];
  platform: string | undefined;
  notifications: Config['notifications'] | undefined;
}): void {
  useEffect(() => {
    if (platform !== 'darwin' || !notifications) return;
    const count = notifications.enabled
      ? prs.reduce((sum, p) => sum + (p.unreadMentionCount ?? 0), 0)
      : 0;
    void invoke('app:setBadgeCount', { count }).catch(() => {
      /* 角标失败不影响主流程 */
    });
  }, [prs, platform, notifications]);
}
