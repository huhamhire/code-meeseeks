import type { TFunction } from 'i18next';
import { formatTimestamp } from '@meebox/shared';

// House timestamp formatters live in @meebox/shared (pure + unit-tested); re-exported here so renderer code keeps
// importing them from utils/time.
export { formatTimestamp, formatDate } from '@meebox/shared';

/**
 * Format a millisecond duration as "Ns" / "Mm SSs":
 *   < 60s  → "42s"
 *   >= 60s → "1m 30s" (seconds zero-padded to a fixed two-digit width); with `compact` the space is dropped → "1m30s" (status bar compact scenario)
 * Uses the `m` / `s` unit literals rather than a colon, to avoid visual confusion with a timestamp (HH:MM).
 */
export function formatElapsed(ms: number, opts?: { compact?: boolean }): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${String(totalSec)}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m)}m${opts?.compact ? '' : ' '}${String(s).padStart(2, '0')}s`;
}

/**
 * Format a point in time as relative time: "just now / N seconds ago / N minutes ago / N hours ago"; beyond 1 day
 * give an absolute time (house format), to avoid vagueness like "3 days ago".
 */
export function formatRelative(date: Date, t: TFunction): string {
  const diffSec = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (diffSec < 30) return t('statusBar.justNow');
  if (diffSec < 60) return t('statusBar.secondsAgo', { count: diffSec });
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return t('statusBar.minutesAgo', { count: diffMin });
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return t('statusBar.hoursAgo', { count: diffHr });
  return formatTimestamp(date, { full: true });
}
