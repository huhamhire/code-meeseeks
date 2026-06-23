// 轮询间隔档位（秒）：低值细（30s 一档）、高值粗（分钟级），梯度放大。滑块拖的是
// 档位索引而非秒数，从而实现非线性步长 + 离散刻度。
export const POLLER_TIERS = [60, 90, 120, 180, 300, 600, 900];

/** 取最接近给定秒数的档位索引（配置值不在档位上时就近吸附） */
export function nearestPollerIdx(seconds: number): number {
  let best = 0;
  for (let i = 1; i < POLLER_TIERS.length; i++) {
    if (Math.abs(POLLER_TIERS[i]! - seconds) < Math.abs(POLLER_TIERS[best]! - seconds)) best = i;
  }
  return best;
}

/** 字节数 → 人类可读（B / KB / MB / GB）。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
