import { STAGGER_MIN_MS, STAGGER_SPAN_MS } from '../constants.js';

/**
 * Stagger concurrently dispatched tool calls by a **cumulative 100~200ms random delay**: the first fires
 * immediately, each of the rest starts 100~200ms after the previous, avoiding different tools firing at the
 * same instant and contending for child-process spawn / LLM network.
 * Return order matches the input (Promise.all preserves order); this doesn't change concurrency semantics, only
 * staggers the start times. Delay parameters see constants.ts.
 */

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runStaggered<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  let cumulative = 0;
  return Promise.all(
    items.map((item, i) => {
      if (i > 0) {
        cumulative += STAGGER_MIN_MS + Math.floor(Math.random() * (STAGGER_SPAN_MS + 1));
      }
      const wait = cumulative;
      return (async () => {
        await sleep(wait);
        return fn(item, i);
      })();
    }),
  );
}
