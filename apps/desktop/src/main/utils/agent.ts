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
 * 把 provider + 用户输入的 model 字符串规整成 litellm 期望的形式。
 *
 * litellm 通过 model 字符串的前缀路由到对应 provider（`deepseek/...` → DeepSeek
 * SDK，`anthropic/...` / `claude-*` → Anthropic，`ollama/...` → Ollama，无前缀
 * → 默认走 OpenAI）。用户在 LLM Profile 里只填模型名（如 `deepseek-v4-pro`），
 * 这里按 provider 自动补前缀，避免 litellm 路由错到 OpenAI 用 `dummy_key` 报错。
 *
 * 用户若手动写了带前缀的形式（兼容多 provider 用户 / 高级用户），不重复加。
 */
function normalizeModel(provider: LlmProfile['provider'], model: string): string {
  if (!model) return model;
  const m = model.trim();
  switch (provider) {
    case 'deepseek':
      return m.startsWith('deepseek/') ? m : `deepseek/${m}`;
    case 'anthropic':
      // claude-* 名字 litellm 直接认；anthropic/ 前缀也直认
      return m.startsWith('anthropic/') || m.startsWith('claude-') ? m : `anthropic/${m}`;
    case 'ollama':
      return m.startsWith('ollama/') ? m : `ollama/${m}`;
    case 'openai':
    case 'openai-compatible':
      // 这两类走 OpenAI 兼容协议，model 名直接用 (litellm 默认 OpenAI 路由)
      return m;
    default:
      return m;
  }
}

/**
 * 把单条 LLM Profile 翻成 pr-agent 认的环境变量。pr-agent 内部 TOML 配置 +
 * 双下划线 env var 覆盖：`[openai] key = ...` ↔ `OPENAI__KEY=...`。
 *
 * 走 env 而不是 `--openai.key=` CLI flag：避免密钥出现在 `ps` 进程列表 /
 * git reflog；env 仅同用户在 /proc/<pid>/environ 可见，相对安全。
 *
 * 空字符串字段一律跳过——别覆盖 pr-agent 默认值或用户 shell 里已有的 env。
 *
 * 此外两条防御性默认：
 * - `CONFIG__CUSTOM_MODEL_MAX_TOKENS`：pr-agent 的 MAX_TOKENS 内置表只覆盖少数主流
 *   模型，DeepSeek / 新 Claude / 自部署 / openai-compatible 都不在表里，跑起来报
 *   "model not defined in MAX_TOKENS"。设个 128K 兜底，跟主流大模型上下文容量对齐
 * - `CONFIG__FALLBACK_MODELS=[]`：pr-agent 默认配了 fallback (一般指向 OpenAI 系列)，
 *   主模型失败后会自动用 dummy key 试 OpenAI，污染日志且容易被误读成"配错了 OpenAI"。
 *   我们已经显式指定 provider，没有 fallback 的必要
 */
export function buildPragentEnv(profile: LlmProfile): Record<string, string> {
  const env: Record<string, string> = {};
  if (profile.model) env['CONFIG__MODEL'] = normalizeModel(profile.provider, profile.model);
  env['CONFIG__CUSTOM_MODEL_MAX_TOKENS'] = '128000';
  env['CONFIG__FALLBACK_MODELS'] = '[]';
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
