import { STAGGER_MIN_MS, STAGGER_SPAN_MS } from '../constants.js';

/**
 * 把并发分发的工具调用相互错开一个**累计的 100~200ms 随机延迟**：首个立即发出，其余各在前一个
 * 基础上再加 100~200ms 起跑，避免不同工具在同一瞬间齐发、抢占子进程 spawn / LLM 网络。
 * 返回顺序与入参一致（Promise.all 保序），不改变并发语义、只错开起跑时刻。延迟参数见 constants.ts。
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
