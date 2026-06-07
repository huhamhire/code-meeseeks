import type { LlmProfile } from '@meebox/shared';

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
      // 一律补 `anthropic/` 前缀让 litellm 按前缀直接路由到 Anthropic。
      // 不能靠裸 `claude-*` 名字——litellm 只对**内置 model_cost 表里**的 claude
      // 型号才能从名字反推 provider；新型号 (如 claude-opus-4-8) 不在表里，裸名传
      // 过去第一道 provider 路由就抛 "LLM Provider NOT provided"。带前缀则无需查表，
      // 厂商原厂模型只填型号名即可直接用。用户手写带前缀的不重复加。
      return m.startsWith('anthropic/') ? m : `anthropic/${m}`;
    case 'ollama':
      return m.startsWith('ollama/') ? m : `ollama/${m}`;
    case 'openai':
      // 真 OpenAI：litellm 认 gpt-* / o1-* 等内置模型名；带 openai/ 前缀也直认。
      // 用户写的就是 litellm 内置表里的名字，不主动加前缀避免重复 (`openai/openai/...`)
      return m;
    case 'openai-compatible':
    case 'dashscope':
    case 'volcengine-ark':
      // OpenAI 兼容协议（DashScope / 火山方舟 / 自部署 vLLM / 中转）— 模型 ID
      // 是平台特定 (qwen-plus / doubao-pro-32k / ep-xxx endpoint id 等)，**不在
      // litellm 内置 MAX_TOKENS 表里**，裸名传过去 litellm 第一道 provider 路由
      // 就报 "LLM Provider NOT provided"。
      // 必须显式 `openai/` 前缀让 litellm 走 "custom OpenAI client + 用 OPENAI_API_BASE
      // 作为 endpoint" 分支，model 字段去前缀后透传给平台
      return m.startsWith('openai/') ? m : `openai/${m}`;
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
 * 此外三条防御性默认：
 * - `CONFIG__MAX_MODEL_TOKENS=128000`：pr-agent **全局 input 上限**，默认 32000；
 *   日志里 "tokens under limit: 32000" 来自这条。DeepSeek-v4 / 现代 Claude / GPT-4
 *   都是 128k 上下文，没必要被 pr-agent 强行截到 32k。设到 128k 让长 PR 能完整入 prompt
 * - `CONFIG__CUSTOM_MODEL_MAX_TOKENS=128000`：pr-agent 的 MAX_TOKENS 内置表只覆盖少
 *   数主流模型，DeepSeek / 新 Claude / 自部署 / openai-compatible 都不在表里，跑起来
 *   报 "model not defined in MAX_TOKENS"。这条是 unknown 模型的兜底
 * - `CONFIG__FALLBACK_MODELS=[]`：pr-agent 默认配了 fallback (一般指向 OpenAI 系列)，
 *   主模型失败后会自动用 dummy key 试 OpenAI，污染日志且容易被误读成"配错了 OpenAI"。
 *   我们已经显式指定 provider，没有 fallback 的必要
 */
export function buildPragentEnv(profile: LlmProfile): Record<string, string> {
  const env: Record<string, string> = {};
  if (profile.model) env['CONFIG__MODEL'] = normalizeModel(profile.provider, profile.model);
  env['CONFIG__MAX_MODEL_TOKENS'] = '128000';
  env['CONFIG__CUSTOM_MODEL_MAX_TOKENS'] = '128000';
  env['CONFIG__FALLBACK_MODELS'] = '[]';
  // litellm import 时会联网拉远端模型价格表（raw.githubusercontent.com），内网/弱网
  // 下 SSL 超时拖慢启动且刷警告。我们只取真实 token 数（来自 API response.usage），
  // 不需要价格表 → 强制只用包内本地备份、彻底不联网。见 sitecustomize 的 usage callback。
  env['LITELLM_LOCAL_MODEL_COST_MAP'] = 'True';
  // 注：没接 LITELLM_LOG / CONFIG__VERBOSITY_LEVEL 因为 pr-agent 0.35 社区版上
  // 都不让 completion tokens 落到 stdout —— pr-agent 把它扔进 logger.debug 的
  // 'artifact' 字段，loguru 默认 INFO 级别滤掉。要拿到 completion tokens 需要走
  // sitecustomize / launcher monkey-patch litellm，独立于 env 实现 (留到后续)
  switch (profile.provider) {
    case 'openai':
    case 'openai-compatible':
    case 'dashscope':
    case 'volcengine-ark': {
      // 阿里百炼 / 火山方舟 / 自部署 vLLM 都暴露 OpenAI 兼容 endpoint。
      //
      // 严格按 pr-agent 官方推荐 (docs/usage-guide/changing_a_model)，只设双下划
      // 线 env: `OPENAI__KEY` / `OPENAI__API_BASE`。pr-agent 内部
      // (litellm_ai_handler.py) 会:
      //   litellm.openai_key = settings.openai.key
      //   litellm.api_base   = settings.openai.api_base
      //   self.api_base      = settings.openai.api_base
      // 并在 `await acompletion(...)` 调用时无条件传 `api_base=self.api_base`。
      //
      // 不要同时设单下划线 `OPENAI_API_KEY` / `OPENAI_BASE_URL` — OpenAI SDK 实例
      // 化时优先读这些环境变量，会把 pr-agent 注入的 `litellm.api_base` 覆盖掉，
      // OpenAI client 改走 SDK 默认 endpoint，请求被打到 https://api.openai.com，
      // DashScope key 必 401 (实测路径)。
      //
      // model 仍需 `openai/<...>` 前缀 (normalizeModel 已加) — litellm 第一道
      // provider 路由按前缀认作 OpenAI-compatible client。裸 model 名 (qwen-plus)
      // 不在 litellm.model_cost 表里，会抛 "LLM Provider NOT provided"。
      //
      // dashscope / volcengine-ark 用 LLM_PROVIDERS 预设兜底 (跟 SettingsModal
      // placeholder 同一份默认 endpoint)，让历史 profile 留空时也能 work。
      // openai-compatible 不兜底 — 它是"自部署/中转代理"语义，endpoint 因人而异
      const baseUrlFallback: Record<string, string> = {
        dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'volcengine-ark': 'https://ark.cn-beijing.volces.com/api/v3',
      };
      const effectiveBaseUrl =
        profile.base_url || baseUrlFallback[profile.provider] || '';

      if (profile.api_key) env['OPENAI__KEY'] = profile.api_key;
      if (effectiveBaseUrl) env['OPENAI__API_BASE'] = effectiveBaseUrl;
      break;
    }
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
