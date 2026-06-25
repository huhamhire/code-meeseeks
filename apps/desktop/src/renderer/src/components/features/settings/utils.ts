// 轮询间隔档位（秒）：低值细（30s 一档）、高值粗（分钟级），梯度放大。滑块拖的是
// 档位索引而非秒数，从而实现非线性步长 + 离散刻度（见 TierSlider）。
export const POLLER_TIERS = [60, 90, 120, 180, 300, 600, 900];

// 评审任务并发档位（pr_agent.max_concurrency，1~8 整数）。
export const CONCURRENCY_TIERS = [1, 2, 3, 4, 5, 6, 7, 8];

// LLM 上下文长度档位（token）：32k~1M 间的主要习惯配置。与 schema 默认 128000 对齐。
export const LLM_CONTEXT_TIERS = [32000, 64000, 128000, 256000, 512000, 1000000];

/** 取最接近给定值的档位索引（配置值不在档位上时就近吸附）。 */
export function nearestTierIdx(tiers: readonly number[], value: number): number {
  let best = 0;
  for (let i = 1; i < tiers.length; i++) {
    if (Math.abs(tiers[i]! - value) < Math.abs(tiers[best]! - value)) best = i;
  }
  return best;
}

/** token 数 → 习惯简写（32000 → 32k，1000000 → 1M）。 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  return `${Math.round(n / 1000)}k`;
}

/** 字节数 → 人类可读（B / KB / MB / GB）。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
