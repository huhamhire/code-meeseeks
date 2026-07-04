export interface TokenUsage {
  /** Input-side (prompt) token count. Comes from litellm when LITELLM_LOG=INFO; fallback uses
      pr-agent's own "Tokens: N" (tiktoken estimate) */
  prompt?: number;
  /** Output-side (completion) token count. Only available when LITELLM_LOG=INFO */
  completion?: number;
  /** Total tokens; prefers what litellm gives, computes prompt+completion when missing */
  total?: number;
  /** Prompt-cache read amount (cache_read), part of prompt; when missing/0 the "(cache N)" parenthesis is not shown */
  cacheRead?: number;
  /** Model interaction turns; not shown separately when ≤1 */
  turns?: number;
}

/**
 * Parse token usage from pr-agent stdout. Multi-source accumulation:
 *
 * 1. litellm INFO mode (on by default for us): after each LLM call it prints something like
 *    `usage={'prompt_tokens': 8423, 'completion_tokens': 1234, 'total_tokens': 9657}`
 *    multiple call rounds → each field accumulates; this one is the most accurate
 *
 * 2. pr-agent's own prompt estimate: `Tokens: 8423, total tokens under limit: ...`
 *    fallback when there is no litellm log; only reflects the input side, taking the max as representative
 *
 * Prefers (1); falls back to (2) when (1) does not match.
 */
export function extractTokenUsage(stdout: string): TokenUsage {
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let hasLitellm = false;
  // litellm's usage dict appears in stdout as a Python repr, single-quoted strings
  // (also matches JSON double quotes for compatibility). All LLM call rounds in one run accumulate
  const usageRe =
    /['"]prompt_tokens['"]\s*:\s*(\d+)[\s,]*['"]completion_tokens['"]\s*:\s*(\d+)[\s,]*['"]total_tokens['"]\s*:\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = usageRe.exec(stdout)) !== null) {
    hasLitellm = true;
    prompt += Number.parseInt(m[1]!, 10) || 0;
    completion += Number.parseInt(m[2]!, 10) || 0;
    total += Number.parseInt(m[3]!, 10) || 0;
  }
  if (hasLitellm) {
    return { prompt, completion, total: total || prompt + completion };
  }
  // Fallback: pr-agent's prompt estimate
  const fallbackRe = /Tokens:\s*(\d+)/gi;
  let maxPrompt: number | undefined;
  while ((m = fallbackRe.exec(stdout)) !== null) {
    const n = Number.parseInt(m[1]!, 10);
    if (!Number.isNaN(n) && (maxPrompt === undefined || n > maxPrompt)) maxPrompt = n;
  }
  return maxPrompt !== undefined ? { prompt: maxPrompt } : {};
}
