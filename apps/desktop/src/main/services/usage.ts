import type { TokenUsage } from '@meebox/shared';

// litellm usage 哨兵行前缀（与 sitecustomize.py 的 _emit 保持一致）。
export const USAGE_SENTINEL = '@@MEEBOX_USAGE@@';

export interface UsageAcc {
  prompt: number;
  completion: number;
  total: number;
  calls: number;
  any: boolean;
}

/** 新建一个空 usage 累加器。 */
export function newUsageAcc(): UsageAcc {
  return { prompt: 0, completion: 0, total: 0, calls: 0, any: false };
}

/**
 * 解析一行 stderr：若含 usage 哨兵（`@@MEEBOX_USAGE@@ {json}`，sitecustomize 注入）则累加到
 * acc 并返回 true（调用方据此吞掉该行、不转发给 renderer / 不入日志）。普通行返回 false。
 * 坏 JSON 也返回 true（仍吞掉，避免漏进实时日志），只是不计数。容错优先。
 */
export function accumulateUsageSentinel(line: string, acc: UsageAcc): boolean {
  const i = line.indexOf(USAGE_SENTINEL);
  if (i < 0) return false;
  try {
    const r = JSON.parse(line.slice(i + USAGE_SENTINEL.length).trim()) as {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
    acc.calls += 1;
    if (typeof r.prompt_tokens === 'number') {
      acc.prompt += r.prompt_tokens;
      acc.any = true;
    }
    if (typeof r.completion_tokens === 'number') {
      acc.completion += r.completion_tokens;
      acc.any = true;
    }
    if (typeof r.total_tokens === 'number') {
      acc.total += r.total_tokens;
      acc.any = true;
    }
  } catch {
    // 坏哨兵行：仍吞掉，不计数
  }
  return true;
}

/** 累加器 → TokenUsage；无任何有效数据返回 undefined（未捕获到，如非 embedded / 流式 / 未调 LLM）。 */
export function finalizeUsage(acc: UsageAcc): TokenUsage | undefined {
  if (!acc.any) return undefined;
  return {
    promptTokens: acc.prompt,
    completionTokens: acc.completion,
    // 优先各次 total 累加；个别次缺 total 时用 prompt+completion 兜底
    totalTokens: acc.total || acc.prompt + acc.completion,
    calls: acc.calls,
  };
}

/**
 * 持久化前从 stderr 去掉 usage 哨兵行：onLine 实时已拦截不转发，但 exec 内部把全量 stderr
 * 累加进 result.stderr（含哨兵），落盘前清掉这些噪声行。
 */
export function stripUsageSentinels(stderr: string | undefined): string | undefined {
  if (!stderr) return stderr;
  return stderr
    .split('\n')
    .filter((l) => !l.includes(USAGE_SENTINEL))
    .join('\n');
}
