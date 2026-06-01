import type { LlmProfile } from '@pr-pilot/shared';

/** 从 llm config 拿当前选中的 profile；active_id 空或找不到都返回 null。 */
export function resolveActiveLlmProfile(llm: {
  profiles: LlmProfile[];
  active_id: string;
}): LlmProfile | null {
  if (!llm.active_id) return null;
  return llm.profiles.find((p) => p.id === llm.active_id) ?? null;
}

/**
 * 把单条 LLM Profile 翻成 pr-agent 认的环境变量。pr-agent 内部 TOML 配置 +
 * 双下划线 env var 覆盖：`[openai] key = ...` ↔ `OPENAI__KEY=...`。
 *
 * 走 env 而不是 `--openai.key=` CLI flag：避免密钥出现在 `ps` 进程列表 /
 * git reflog；env 仅同用户在 /proc/<pid>/environ 可见，相对安全。
 *
 * 空字符串字段一律跳过——别覆盖 pr-agent 默认值或用户 shell 里已有的 env。
 */
export function buildPragentEnv(profile: LlmProfile): Record<string, string> {
  const env: Record<string, string> = {};
  if (profile.model) env['CONFIG__MODEL'] = profile.model;
  switch (profile.provider) {
    case 'openai':
    case 'openai-compatible':
      if (profile.api_key) env['OPENAI__KEY'] = profile.api_key;
      if (profile.base_url) env['OPENAI__API_BASE'] = profile.base_url;
      break;
    case 'deepseek':
      // litellm 走 deepseek/<model> 路径；env 用 DEEPSEEK__KEY。base_url 一般无需填
      if (profile.api_key) env['DEEPSEEK__KEY'] = profile.api_key;
      if (profile.base_url) env['DEEPSEEK__API_BASE'] = profile.base_url;
      break;
    case 'anthropic':
      if (profile.api_key) env['ANTHROPIC__KEY'] = profile.api_key;
      break;
    case 'ollama':
      if (profile.base_url) env['OLLAMA__API_BASE'] = profile.base_url;
      break;
  }
  return env;
}
