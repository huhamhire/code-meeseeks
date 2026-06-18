export interface TokenUsage {
  /** 输入侧 (prompt) token 数。LITELLM_LOG=INFO 时来自 litellm；fallback 用 pr-agent
      自己打的 "Tokens: N" (tiktoken 预估) */
  prompt?: number;
  /** 输出侧 (completion) token 数。仅 LITELLM_LOG=INFO 时可拿到 */
  completion?: number;
  /** 总 token；优先用 litellm 给的，缺时算 prompt+completion */
  total?: number;
}

/**
 * 从 pr-agent stdout 解析 token 用量。多源累加：
 *
 * 1. litellm INFO 模式 (我们默认开)：每次 LLM 调用后会打类似
 *    `usage={'prompt_tokens': 8423, 'completion_tokens': 1234, 'total_tokens': 9657}`
 *    多轮调用 → 各项累加；这条最准
 *
 * 2. pr-agent 自己的 prompt 预估：`Tokens: 8423, total tokens under limit: ...`
 *    没 litellm 日志兜底；只反映输入侧，按最大值取代表
 *
 * 优先用 (1)；(1) 没命中再退到 (2)。
 */
export function extractTokenUsage(stdout: string): TokenUsage {
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let hasLitellm = false;
  // litellm 的 usage dict 在 stdout 里以 Python repr 形式出现，单引号字符串
  // (兼容 JSON 双引号也匹配)。一次 run 多轮 LLM 调用全部累加
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
  // Fallback: pr-agent 的 prompt 预估
  const fallbackRe = /Tokens:\s*(\d+)/gi;
  let maxPrompt: number | undefined;
  while ((m = fallbackRe.exec(stdout)) !== null) {
    const n = Number.parseInt(m[1]!, 10);
    if (!Number.isNaN(n) && (maxPrompt === undefined || n > maxPrompt)) maxPrompt = n;
  }
  return maxPrompt !== undefined ? { prompt: maxPrompt } : {};
}
