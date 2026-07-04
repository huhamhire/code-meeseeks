import { useEffect } from 'react';
import type { Config, StoredPullRequest } from '@meebox/shared';
import { invoke } from '../api';

/**
 * macOS dock badge sync: pushes the total pending-response count of active PRs ("@me / replies to me") to the main
 * process to land on the dock icon. The badge has no independent switch — it follows the notification master switch,
 * enabled by default, and is set to 0 to clear when disabled; skipped outright on non-macOS (the main process also
 * only lands it on macOS). Recomputes and pushes as the PR list / notification config changes. Each PR's count is
 * already capped at 10 on the poll side, so the total has a built-in upper bound.
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
      /* badge failure does not affect the main flow */
    });
  }, [prs, platform, notifications]);
}
