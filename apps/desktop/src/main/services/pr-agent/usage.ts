import type { TokenUsage } from '@meebox/shared';

// litellm usage sentinel-line prefix (kept consistent with sitecustomize.py's _emit).
export const USAGE_SENTINEL = '@@MEEBOX_USAGE@@';

export interface UsageAcc {
  prompt: number;
  completion: number;
  total: number;
  calls: number;
  /** Cumulative prompt-cache read tokens (cache_read), part of prompt */
  cacheRead: number;
  /** Cumulative model interaction turns: in CLI agentic mode comes from each sentinel's num_turns (can accumulate multiple segments within one run) */
  turns: number;
  any: boolean;
}

/** Create a new empty usage accumulator. */
export function newUsageAcc(): UsageAcc {
  return { prompt: 0, completion: 0, total: 0, calls: 0, cacheRead: 0, turns: 0, any: false };
}

/**
 * Parse one stderr line: if it contains a usage sentinel (`@@MEEBOX_USAGE@@ {json}`, injected by sitecustomize), accumulate into
 * acc and return true (the caller thus swallows the line, not forwarding to the renderer / not logging). Normal lines return false.
 * Bad JSON also returns true (still swallowed, to avoid leaking into live logs), just not counted. Fault-tolerance first.
 */
export function accumulateUsageSentinel(line: string, acc: UsageAcc): boolean {
  const i = line.indexOf(USAGE_SENTINEL);
  if (i < 0) return false;
  try {
    const r = JSON.parse(line.slice(i + USAGE_SENTINEL.length).trim()) as {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      cache_read_tokens?: number;
      turns?: number;
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
    if (typeof r.cache_read_tokens === 'number') acc.cacheRead += r.cache_read_tokens;
    if (typeof r.turns === 'number') acc.turns += r.turns;
  } catch {
    // Bad sentinel line: still swallowed, not counted
  }
  return true;
}

/** Accumulator → TokenUsage; returns undefined if there's no valid data (nothing captured, e.g. non-embedded / streaming / LLM never called). */
export function finalizeUsage(acc: UsageAcc): TokenUsage | undefined {
  if (!acc.any) return undefined;
  return {
    promptTokens: acc.prompt,
    completionTokens: acc.completion,
    // Prefer accumulating each call's total; fall back to prompt+completion when an individual call lacks total
    totalTokens: acc.total || acc.prompt + acc.completion,
    calls: acc.calls,
    // Omit cache_read when there's no hit (0); turns prefers the CLI-reported turns, falling back to the call count when missing
    cacheReadTokens: acc.cacheRead || undefined,
    turns: acc.turns || acc.calls,
  };
}

/**
 * Strip shim sentinel lines from stderr before persistence: onLine already intercepts them in real time without forwarding, but exec internally
 * accumulates all stderr into result.stderr (including sentinels), so clear these noise lines before persisting.
 */
export function stripShimSentinels(stderr: string | undefined): string | undefined {
  if (!stderr) return stderr;
  return stderr
    .split('\n')
    .filter((l) => !l.includes(USAGE_SENTINEL) && !l.includes(LLM_ERROR_SENTINEL))
    .join('\n');
}

/**
 * LLM-error sentinel-line prefix (kept consistent with the shim's usage._emit_llm_error). Shares the stderr sentinel
 * channel with usage: pr-agent's fallback retry logs the underlying exception into loguru's `artifact=` field, which the
 * default format drops, so the real cause never reaches stdout — the shim routes it out of band through this line.
 */
export const LLM_ERROR_SENTINEL = '@@MEEBOX_LLM_ERROR@@';

/**
 * Pull the LLM-call cause out of stderr sentinel lines, returning the **last** one (a run may retry several times; the last
 * is what actually sank the run). Bad JSON / a missing message is ignored — this is a diagnostic enrichment, never a
 * reason to fail differently.
 */
export function parseLlmErrorSentinel(
  stderr: string | undefined,
): { cli?: string; message: string } | undefined {
  if (!stderr) return undefined;
  let found: { cli?: string; message: string } | undefined;
  for (const line of stderr.split('\n')) {
    const i = line.indexOf(LLM_ERROR_SENTINEL);
    if (i < 0) continue;
    try {
      const rec = JSON.parse(line.slice(i + LLM_ERROR_SENTINEL.length).trim()) as {
        cli?: unknown;
        message?: unknown;
      };
      if (typeof rec.message === 'string' && rec.message.trim()) {
        found = {
          cli: typeof rec.cli === 'string' ? rec.cli : undefined,
          message: rec.message.trim(),
        };
      }
    } catch {
      // Malformed sentinel → skip, keep any earlier one.
    }
  }
  return found;
}
