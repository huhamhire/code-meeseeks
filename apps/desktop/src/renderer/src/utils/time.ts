import type { TFunction } from 'i18next';

/**
 * 把毫秒时长格式化为 "Ns" / "Mm SSs"：
 *   < 60s  → "42s"
 *   >= 60s → "1m 30s"（秒两位补零定宽）；`compact` 时去掉空格 → "1m30s"（状态栏紧凑场景）
 * 用 `m` / `s` 单位字面而非冒号，避免跟时间戳 (HH:MM) 视觉混淆。
 */
export function formatElapsed(ms: number, opts?: { compact?: boolean }): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${String(totalSec)}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m)}m${opts?.compact ? '' : ' '}${String(s).padStart(2, '0')}s`;
}

/**
 * 把时间点格式化为相对时间："刚刚 / N 秒前 / N 分钟前 / N 小时前"；超过 1 天给绝对时间，
 * 避免 "3 天前" 这种模糊。
 */
export function formatRelative(date: Date, t: TFunction): string {
  const diffSec = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (diffSec < 30) return t('statusBar.justNow');
  if (diffSec < 60) return t('statusBar.secondsAgo', { count: diffSec });
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return t('statusBar.minutesAgo', { count: diffMin });
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return t('statusBar.hoursAgo', { count: diffHr });
  return date.toLocaleString();
}
