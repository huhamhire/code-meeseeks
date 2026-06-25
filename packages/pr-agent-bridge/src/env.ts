import type { LlmProfile, ReviewRunTool } from '@meebox/shared';
import { LLM_CONTEXT_TOKENS_DEFAULT } from '@meebox/shared';
import { PRAGENT_LOCAL_OUTPUT } from './constants.js';

/**
 * pr-agent 环境变量构造：把一条 LLM Profile 翻成 pr-agent / 嵌入式 shim 认的 env（provider 凭据 /
 * 模型 / litellm 路由前缀 / 编排 chat 的推理档与缓存）。这层是 pr-agent 运行时契约（双下划线 env key、
 * litellm 前缀路由、shim 哨兵 env），归属 pr-agent 适配包；主服务只传 LlmProfile + 高层意图，不直接
 * 拼 CONFIG__* / MEEBOX_* key。纯函数、无 I/O。
 */

/**
 * 把 provider + 用户输入的 model 字符串规整成 litellm 期望的形式。
 *
 * litellm 通过 model 字符串的前缀路由到对应 provider（`deepseek/...` → DeepSeek
 * SDK，`anthropic/...` / `claude-*` → Anthropic，`openai/...` → OpenAI 兼容客户端，
 * 无前缀 → 默认走 OpenAI）。用户在 LLM Profile 里只填模型名（如 `deepseek-v4-pro`），
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
    case 'cli':
      // cli 模式完全绕过 litellm（shim 替换 chat_completion 直接调本机 CLI），model
      // 字段是命令名 (claude) 不是 litellm 模型名，原样透传。CONFIG__MODEL 仅供
      // pr-agent 内部 token 估算用（未知名 → 走 custom_model_max_tokens 兜底）。
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
 * 此外三条防御性默认：
 * - `CONFIG__MAX_MODEL_TOKENS`：pr-agent **全局 input 上限**，默认 32000；日志里
 *   "tokens under limit: 32000" 来自这条。DeepSeek-v4 / 现代 Claude / GPT-4 都是 128k+
 *   上下文，没必要被 pr-agent 强行截到 32k。由 `maxModelTokens`（用户「上下文长度」设置）控制、
 *   默认 128000，让长 PR 能完整入 prompt。**CLI 模式忽略该设置**（CLI 工具自管上下文）、固定默认值。
 * - `CONFIG__CUSTOM_MODEL_MAX_TOKENS`（同上取值）：pr-agent 的 MAX_TOKENS 内置表只覆盖少
 *   数主流模型，DeepSeek / 新 Claude / 自部署 / openai-compatible 都不在表里，跑起来
 *   报 "model not defined in MAX_TOKENS"。这条是 unknown 模型的兜底
 * - `CONFIG__FALLBACK_MODELS=[]`：pr-agent 默认配了 fallback (一般指向 OpenAI 系列)，
 *   主模型失败后会自动用 dummy key 试 OpenAI，污染日志且容易被误读成"配错了 OpenAI"。
 *   我们已经显式指定 provider，没有 fallback 的必要
 */
export function buildPragentEnv(profile: LlmProfile, maxModelTokens?: number): Record<string, string> {
  const env: Record<string, string> = {};
  if (profile.model) env['CONFIG__MODEL'] = normalizeModel(profile.provider, profile.model);
  // 上下文长度：用户「上下文长度」设置控制 input 裁剪上限；CLI 模式忽略（工具自管上下文）→ 固定默认值。
  const contextTokens =
    profile.provider === 'cli' ? LLM_CONTEXT_TOKENS_DEFAULT : (maxModelTokens ?? LLM_CONTEXT_TOKENS_DEFAULT);
  env['CONFIG__MAX_MODEL_TOKENS'] = String(contextTokens);
  env['CONFIG__CUSTOM_MODEL_MAX_TOKENS'] = String(contextTokens);
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
      const effectiveBaseUrl = profile.base_url || baseUrlFallback[profile.provider] || '';

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
      // base_url 必须走 litellm 原生 env `ANTHROPIC_API_BASE`（单下划线），**不能**用
      // pr-agent 风格的双下划线 `ANTHROPIC__API_BASE`：pr-agent 0.36 的 litellm_ai_handler
      // 只读 settings.anthropic.key、不读 anthropic.api_base，对 anthropic 把 api_base=None
      // 透传给 litellm.acompletion；litellm 的 get_api_base 仅在 api_base 为空时才回落到
      // ANTHROPIC_API_BASE / ANTHROPIC_BASE_URL（都没有才用官方 https://api.anthropic.com）。
      // litellm 默认会给 base 自动补 `/v1/messages`，故填到根域名即可、勿自带该后缀（中转端点
      // 本身已是完整路径时，另设 LITELLM_ANTHROPIC_DISABLE_URL_SUFFIX=true 关掉自动补全）。
      if (profile.base_url) env['ANTHROPIC_API_BASE'] = profile.base_url;
      break;
    case 'cli': {
      // 本地 CLI 模式：不直连任何 API，也不下发任何密钥。仅打两个哨兵 env 让
      // sitecustomize shim 在 pr-agent 进程内把 LiteLLMAIHandler.chat_completion
      // 整体换成「调本机 CLI 子进程」版本（见 scripts/pragent-shim/meebox_pragent_shim/cli/）。
      //   MEEBOX_CLI_MODE=1   —— 开关；非空即启用 CLI 接管
      //   MEEBOX_CLI_BIN=claude —— 要调用的命令名（一期仅 claude；shim 用 which 解析真实路径）
      // CLI 进程经子进程继承父 env（含 PATH / HOME），故能找到 claude 二进制并读到
      // ~/.claude 登录态。CONFIG__MODEL 已在上面置为命令名 (claude)，仅用于 token 估算。
      const bin = (profile.model || 'claude').trim() || 'claude';
      env['MEEBOX_CLI_MODE'] = '1';
      env['MEEBOX_CLI_BIN'] = bin;
      break;
    }
  }
  return env;
}

/** 编排 chat 通道的 env 高层选项：调用方只表达意图，key 名由 bridge 持有。 */
export interface ChatEnvOptions {
  /** pr-agent 响应语言（CONFIG__RESPONSE_LANGUAGE）；空则不设。 */
  responseLanguage?: string;
  /**
   * 调低推理档（编排 chat 是路由 + 轻量综合，非深度代码分析，那在 pr-agent /review 里）。两条路径都降档提速：
   * - 本机 CLI 模式：MEEBOX_CLI_REASONING=low（codex → model_reasoning_effort=low、claude → haiku；见 cli/specs）。
   * - API / litellm 模式：CONFIG__REASONING_EFFORT=low（pr-agent 仅对 support_reasoning_models 应用，
   *   非 reasoning 模型该项无副作用），避免一个 yes/no 路由判读也吐大量思考 token、拖慢响应。
   */
  lowReasoning?: boolean;
  /**
   * 服务端提示缓存（MEEBOX_CHAT_CACHE，5min TTL）：为编排 chat 的大块 system 前缀打 cache_control。多轮规划逐轮
   * 共享同一 system → 第 2 轮起命中、降延迟/成本（仅 Anthropic 需显式标；OpenAI/DeepSeek 自动前缀缓存）。判读 system
   * 过小不达缓存粒度自动跳过（见 litellm_handler）。
   */
  promptCache?: boolean;
  /** 裁剪输入内容的上下文长度上限（token，CONFIG__MAX_MODEL_TOKENS）；空则用默认 128000。CLI 模式忽略。 */
  maxModelTokens?: number;
}

/**
 * 组装编排 chat 通道的 pr-agent env：在 LLM Profile 基础 env（provider 凭据 / 模型）之上叠加 chat 专属的
 * 响应语言 / 推理档 / 提示缓存契约 key。调用方传 LlmProfile + 高层意图（不直接写 CONFIG__* / MEEBOX_* key）。
 * profile 为 null（未配置 active profile）时仅返回意图相关的 key。代理 env 由调用方另铺（非 pr-agent 范畴）。
 */
export function buildChatEnv(
  profile: LlmProfile | null,
  opts: ChatEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = profile ? buildPragentEnv(profile, opts.maxModelTokens) : {};
  if (opts.responseLanguage) env['CONFIG__RESPONSE_LANGUAGE'] = opts.responseLanguage;
  if (opts.lowReasoning) {
    env['MEEBOX_CLI_REASONING'] = 'low';
    env['CONFIG__REASONING_EFFORT'] = 'low';
  }
  if (opts.promptCache) env['MEEBOX_CHAT_CACHE'] = '1';
  return env;
}

/** pr-agent tool run 的 env 高层选项：调用方只表达意图（tool + 响应语言），契约 key 由 bridge 持有。 */
export interface ToolEnvOptions {
  tool: ReviewRunTool;
  /** pr-agent 响应语言（CONFIG__RESPONSE_LANGUAGE）；空则不设。 */
  responseLanguage?: string;
  /** 裁剪输入内容的上下文长度上限（token，CONFIG__MAX_MODEL_TOKENS）；空则用默认 128000。CLI 模式忽略。 */
  maxModelTokens?: number;
}

/**
 * 组装一次 pr-agent tool run 的 env：在 LLM Profile 基础 env 之上叠加响应语言与 per-tool pr-agent 配置 key。
 * 调用方传 LlmProfile + 意图（不直接写 CONFIG__* / PR_CODE_SUGGESTIONS__* / LOCAL__* key）。代理 env 由调用方
 * 另铺（非 pr-agent 范畴）。
 *
 * /improve 在 local provider 下只有「汇总建议 → publish_comment」一条可用路径（shim 已强制 gfm_markdown=True），
 * 故显式关死两项默认、并把产出重定向到 improve.md：
 * - PR_CODE_SUGGESTIONS__COMMITABLE_CODE_SUGGESTIONS=false：committable/inline 会走 publish_code_suggestions →
 *   local provider 直接 NotImplementedError（pr-agent 默认即 false，此处防上游翻默认值）。
 * - PR_CODE_SUGGESTIONS__PERSISTENT_COMMENT=false：persistent_comment（默认 true）会翻历史评论做增量更新 →
 *   local provider 不实现、每次刷一段 NotImplementedError traceback（被兜底捕获，正文不丢但日志吵）；local 每次
 *   全新 worktree、无历史可翻，直接关掉走 publish_comment。
 * - LOCAL__REVIEW_PATH=improve.md：与 /review /ask 的 review.md 分流（pr-agent 原生 local.review_path 覆盖
 *   publish_comment 落盘路径，相对路径按子进程 cwd = worktree 根解析）。
 */
export function buildToolEnv(
  profile: LlmProfile | null,
  opts: ToolEnvOptions,
): Record<string, string> {
  const env: Record<string, string> = profile ? buildPragentEnv(profile, opts.maxModelTokens) : {};
  if (opts.responseLanguage) env['CONFIG__RESPONSE_LANGUAGE'] = opts.responseLanguage;
  if (opts.tool === 'improve') {
    env['PR_CODE_SUGGESTIONS__COMMITABLE_CODE_SUGGESTIONS'] = 'false';
    env['PR_CODE_SUGGESTIONS__PERSISTENT_COMMENT'] = 'false';
    env['LOCAL__REVIEW_PATH'] = PRAGENT_LOCAL_OUTPUT.improve;
  }
  return env;
}
