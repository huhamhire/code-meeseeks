// Poll-interval tiers (seconds): fine at low values (30s per step), coarse at high values (minute-level), with a widening gradient. The slider drags
// the tier index rather than the seconds, achieving a nonlinear step size + discrete ticks (see TierSlider).
export const POLLER_TIERS = [60, 90, 120, 180, 300, 600, 900];

// Review-task concurrency tiers (pr_agent.max_concurrency, integer 1~8).
export const CONCURRENCY_TIERS = [1, 2, 3, 4, 5, 6, 7, 8];

// LLM context-length tiers (tokens): the main conventional configs between 32k~1M. Aligned with the schema default 128000.
export const LLM_CONTEXT_TIERS = [32000, 64000, 128000, 256000, 512000, 1000000];

/** Get the tier index closest to the given value (snap to the nearest when the config value isn't on a tier). */
export function nearestTierIdx(tiers: readonly number[], value: number): number {
  let best = 0;
  for (let i = 1; i < tiers.length; i++) {
    if (Math.abs(tiers[i]! - value) < Math.abs(tiers[best]! - value)) best = i;
  }
  return best;
}

/** Token count → conventional shorthand (32000 → 32k, 1000000 → 1M). */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  return `${Math.round(n / 1000)}k`;
}

/** Byte count → human-readable (B / KB / MB / GB). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
