import type { LlmProfile, ReviewRunTool } from '@meebox/shared';
import { LLM_CONTEXT_TOKENS_DEFAULT } from '@meebox/shared';
import { PRAGENT_LOCAL_OUTPUT } from './constants.js';

/**
 * pr-agent environment variable construction: translate one LLM Profile into the env pr-agent / the embedded shim
 * recognize (provider credentials / model / litellm routing prefix / reasoning profile and cache for orchestration chat).
 * This layer is the pr-agent runtime contract (double-underscore env keys, litellm prefix routing, shim sentinel env),
 * belonging to the pr-agent adapter package; the main service only passes LlmProfile + high-level intent, not directly
 * assembling CONFIG__* / MEEBOX_* keys. Pure function, no I/O.
 */

/**
 * Normalize the provider + user-input model string into the form litellm expects.
 *
 * litellm routes to the corresponding provider by the model string's prefix (`deepseek/...` → DeepSeek
 * SDK, `anthropic/...` / `claude-*` → Anthropic, `openai/...` → OpenAI-compatible client,
 * no prefix → defaults to OpenAI). In an LLM Profile the user fills in only the model name (e.g. `deepseek-v4-pro`),
 * and here we auto-add the prefix by provider, to avoid litellm misrouting to OpenAI and erroring with `dummy_key`.
 *
 * If the user manually wrote the prefixed form (for multi-provider / advanced users), we don't add it again.
 */
function normalizeModel(provider: LlmProfile['provider'], model: string): string {
  if (!model) return model;
  const m = model.trim();
  switch (provider) {
    case 'deepseek':
      return m.startsWith('deepseek/') ? m : `deepseek/${m}`;
    case 'anthropic':
      // Always add the `anthropic/` prefix so litellm routes directly to Anthropic by prefix.
      // Can't rely on a bare `claude-*` name — litellm can only infer the provider from the name for
      // claude models **in the built-in model_cost table**; new models (e.g. claude-opus-4-8) aren't in
      // the table, and a bare name throws "LLM Provider NOT provided" at the first provider routing step.
      // With the prefix no table lookup is needed, and a vendor's first-party models work by filling in
      // just the model name. If the user hand-wrote the prefix, we don't add it again.
      return m.startsWith('anthropic/') ? m : `anthropic/${m}`;
    case 'openai':
      // Real OpenAI: litellm recognizes built-in model names like gpt-* / o1-*; the openai/ prefix is also accepted directly.
      // What the user writes is a name in litellm's built-in table, so we don't proactively add a prefix to avoid duplication (`openai/openai/...`)
      return m;
    case 'openai-compatible':
    case 'dashscope':
    case 'volcengine-ark':
      // OpenAI-compatible protocol (DashScope / Volcengine Ark / self-hosted vLLM / relay) — the model ID
      // is platform-specific (qwen-plus / doubao-pro-32k / ep-xxx endpoint id, etc.), **not in
      // litellm's built-in MAX_TOKENS table**, so a bare name throws "LLM Provider NOT provided" at
      // litellm's first provider routing step.
      // The explicit `openai/` prefix is required so litellm takes the "custom OpenAI client + use OPENAI_API_BASE
      // as endpoint" branch; the model field is passed through to the platform after the prefix is stripped
      return m.startsWith('openai/') ? m : `openai/${m}`;
    case 'cli':
      // cli mode fully bypasses litellm (the shim replaces chat_completion to call the local CLI directly), the model
      // field is a command name (claude) not a litellm model name, passed through as-is. CONFIG__MODEL is only for
      // pr-agent's internal token estimation (unknown name → falls back to custom_model_max_tokens).
      return m;
    default:
      return m;
  }
}

/**
 * Translate a single LLM Profile into the environment variables pr-agent recognizes. pr-agent uses internal TOML config +
 * double-underscore env var overrides: `[openai] key = ...` ↔ `OPENAI__KEY=...`.
 *
 * Uses env rather than the `--openai.key=` CLI flag: to keep the secret out of the `ps` process list /
 * git reflog; env is only visible to the same user at /proc/<pid>/environ, relatively safe.
 *
 * Empty-string fields are always skipped — don't override pr-agent's default or the env already present in the user's shell.
 *
 * Plus three defensive defaults:
 * - `CONFIG__MAX_MODEL_TOKENS`: pr-agent's **global input limit**, default 32000; the log's
 *   "tokens under limit: 32000" comes from this. DeepSeek-v4 / modern Claude / GPT-4 all have 128k+
 *   context, no need for pr-agent to forcibly truncate to 32k. Controlled by `maxModelTokens` (the user's "context length" setting),
 *   default 128000, so a long PR fits fully into the prompt. **CLI mode ignores this setting** (the CLI tool manages its own context), fixed at the default.
 * - `CONFIG__CUSTOM_MODEL_MAX_TOKENS` (same value as above): pr-agent's built-in MAX_TOKENS table only covers a
 *   few mainstream models; DeepSeek / new Claude / self-hosted / openai-compatible are all absent from the table, and running
 *   errors with "model not defined in MAX_TOKENS". This is the fallback for unknown models
 * - `CONFIG__FALLBACK_MODELS=[]`: pr-agent configures a fallback by default (usually pointing at the OpenAI family),
 *   and after the main model fails it automatically tries OpenAI with a dummy key, polluting the log and easily misread as "OpenAI misconfigured".
 *   We already specify the provider explicitly, so a fallback is unnecessary
 */
export function buildPragentEnv(profile: LlmProfile, maxModelTokens?: number): Record<string, string> {
  const env: Record<string, string> = {};
  if (profile.model) env['CONFIG__MODEL'] = normalizeModel(profile.provider, profile.model);
  // Context length: the user's "context length" setting controls the input truncation limit; CLI mode ignores it (the tool manages its own context) → fixed at the default.
  const contextTokens =
    profile.provider === 'cli' ? LLM_CONTEXT_TOKENS_DEFAULT : (maxModelTokens ?? LLM_CONTEXT_TOKENS_DEFAULT);
  env['CONFIG__MAX_MODEL_TOKENS'] = String(contextTokens);
  env['CONFIG__CUSTOM_MODEL_MAX_TOKENS'] = String(contextTokens);
  env['CONFIG__FALLBACK_MODELS'] = '[]';
  // On import litellm fetches the remote model price table over the network (raw.githubusercontent.com); on an intranet/weak network
  // the SSL timeout slows startup and floods warnings. We only take the real token count (from API response.usage),
  // don't need the price table → force using only the in-package local backup, no network at all. See sitecustomize's usage callback.
  env['LITELLM_LOCAL_MODEL_COST_MAP'] = 'True';
  // Note: LITELLM_LOG / CONFIG__VERBOSITY_LEVEL aren't wired in because on the pr-agent 0.35 community edition
  // neither lets completion tokens reach stdout — pr-agent dumps it into logger.debug's
  // 'artifact' field, which loguru's default INFO level filters out. Getting completion tokens requires
  // sitecustomize / launcher monkey-patching litellm, implemented independently of env (left for later)
  switch (profile.provider) {
    case 'openai':
    case 'openai-compatible':
    case 'dashscope':
    case 'volcengine-ark': {
      // Alibaba DashScope / Volcengine Ark / self-hosted vLLM all expose an OpenAI-compatible endpoint.
      //
      // Strictly following pr-agent's official recommendation (docs/usage-guide/changing_a_model), only set the double-underscore
      // env: `OPENAI__KEY` / `OPENAI__API_BASE`. Internally pr-agent
      // (litellm_ai_handler.py) does:
      //   litellm.openai_key = settings.openai.key
      //   litellm.api_base   = settings.openai.api_base
      //   self.api_base      = settings.openai.api_base
      // and on the `await acompletion(...)` call unconditionally passes `api_base=self.api_base`.
      //
      // Don't also set the single-underscore `OPENAI_API_KEY` / `OPENAI_BASE_URL` — the OpenAI SDK reads these
      // environment variables first when instantiating, which overrides the `litellm.api_base` pr-agent injected,
      // making the OpenAI client take the SDK's default endpoint, sending requests to https://api.openai.com,
      // and the DashScope key inevitably 401s (a tested path).
      //
      // model still needs the `openai/<...>` prefix (normalizeModel already adds it) — litellm's first
      // provider routing recognizes it as an OpenAI-compatible client by prefix. A bare model name (qwen-plus)
      // isn't in the litellm.model_cost table and throws "LLM Provider NOT provided".
      //
      // dashscope / volcengine-ark fall back to the LLM_PROVIDERS profile (the same default endpoint as the SettingsModal
      // placeholder), so a legacy profile still works when left blank.
      // openai-compatible has no fallback — it carries "self-hosted/relay proxy" semantics, and the endpoint varies per user
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
      // litellm takes the deepseek/<model> path; env uses DEEPSEEK__KEY. base_url generally doesn't need to be filled in
      if (profile.api_key) env['DEEPSEEK__KEY'] = profile.api_key;
      if (profile.base_url) env['DEEPSEEK__API_BASE'] = profile.base_url;
      break;
    case 'anthropic':
      if (profile.api_key) env['ANTHROPIC__KEY'] = profile.api_key;
      // base_url must go through litellm's native env `ANTHROPIC_API_BASE` (single underscore), and **cannot** use
      // the pr-agent-style double-underscore `ANTHROPIC__API_BASE`: pr-agent 0.36's litellm_ai_handler
      // only reads settings.anthropic.key, not anthropic.api_base, passing api_base=None through to
      // litellm.acompletion for anthropic; litellm's get_api_base only falls back to
      // ANTHROPIC_API_BASE / ANTHROPIC_BASE_URL when api_base is empty (and uses the official https://api.anthropic.com only if neither is set).
      // litellm by default auto-appends `/v1/messages` to the base, so fill in the root domain and don't include that suffix yourself (when a relay endpoint
      // is itself already a full path, additionally set LITELLM_ANTHROPIC_DISABLE_URL_SUFFIX=true to turn off the auto-completion).
      if (profile.base_url) env['ANTHROPIC_API_BASE'] = profile.base_url;
      break;
    case 'cli': {
      // Local CLI mode: doesn't connect to any API directly, nor hand down any secret. Only sets two sentinel env vars so the
      // sitecustomize shim, inside the pr-agent process, swaps LiteLLMAIHandler.chat_completion
      // wholesale for a "call the local CLI subprocess" version (see scripts/pragent-shim/meebox_pragent_shim/cli/).
      //   MEEBOX_CLI_MODE=1   —— switch; any non-empty value enables the CLI takeover
      //   MEEBOX_CLI_BIN=claude —— the command name to invoke (phase one is claude only; the shim resolves the real path with which)
      // The CLI process inherits the parent env (including PATH / HOME) via the subprocess, so it can find the claude binary and read the
      // ~/.claude login state. CONFIG__MODEL was set to the command name (claude) above, used only for token estimation.
      const bin = (profile.model || 'claude').trim() || 'claude';
      env['MEEBOX_CLI_MODE'] = '1';
      env['MEEBOX_CLI_BIN'] = bin;
      break;
    }
  }
  return env;
}

/** High-level env options for the orchestration chat channel: the caller only expresses intent, the key names are held by the bridge. */
export interface ChatEnvOptions {
  /** pr-agent response language (CONFIG__RESPONSE_LANGUAGE); if empty, not set. */
  responseLanguage?: string;
  /**
   * Lower the reasoning profile (orchestration chat is routing + light synthesis, not deep code analysis — that's in pr-agent /review). Both paths lower the profile to speed up:
   * - local CLI mode: MEEBOX_CLI_REASONING=low (codex → model_reasoning_effort=low, claude → haiku; see cli/specs).
   * - API / litellm mode: CONFIG__REASONING_EFFORT=low (pr-agent only applies it to support_reasoning_models,
   *   with no side effect on non-reasoning models), to avoid a single yes/no routing decision also spewing lots of thinking tokens and slowing the response.
   */
  lowReasoning?: boolean;
  /**
   * Server-side prompt cache (MEEBOX_CHAT_CACHE, 5min TTL): applies cache_control to the orchestration chat's large system prefix. Multi-round planning shares the same
   * system round over round → hits from the 2nd round onward, lowering latency/cost (only Anthropic needs an explicit marker; OpenAI/DeepSeek cache the prefix automatically). It automatically skips when
   * the system is too small to reach the cache granularity (see litellm_handler).
   */
  promptCache?: boolean;
  /** Context length limit for truncating input content (tokens, CONFIG__MAX_MODEL_TOKENS); if empty, uses the default 128000. Ignored in CLI mode. */
  maxModelTokens?: number;
}

/**
 * Assemble the pr-agent env for the orchestration chat channel: on top of the LLM Profile's base env (provider credentials / model), layer the chat-specific
 * response language / reasoning profile / prompt cache contract keys. The caller passes LlmProfile + high-level intent (not directly writing CONFIG__* / MEEBOX_* keys).
 * When profile is null (no active profile configured) only the intent-related keys are returned. The proxy env is laid out separately by the caller (outside the pr-agent scope).
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

/** High-level env options for a pr-agent tool run: the caller only expresses intent (tool + response language), the contract keys are held by the bridge. */
export interface ToolEnvOptions {
  tool: ReviewRunTool;
  /** pr-agent response language (CONFIG__RESPONSE_LANGUAGE); if empty, not set. */
  responseLanguage?: string;
  /** Context length limit for truncating input content (tokens, CONFIG__MAX_MODEL_TOKENS); if empty, uses the default 128000. Ignored in CLI mode. */
  maxModelTokens?: number;
  /**
   * Upper limit on the number of code suggestions / review findings (2~8): /review → PR_REVIEWER__NUM_MAX_FINDINGS,
   * /improve → PR_CODE_SUGGESTIONS__NUM_CODE_SUGGESTIONS (both hard limits). If empty, uses pr-agent's default.
   * /ask's soft constraint goes through the prompt (see buildExtraInstructions), not this.
   */
  maxCodeSuggestions?: number;
}

/**
 * Assemble the env for a single pr-agent tool run: on top of the LLM Profile's base env, layer the response language and per-tool pr-agent config keys.
 * The caller passes LlmProfile + intent (not directly writing CONFIG__* / PR_CODE_SUGGESTIONS__* / LOCAL__* keys). The proxy env is laid out
 * separately by the caller (outside the pr-agent scope).
 *
 * Under the local provider /improve has only one usable path, "aggregated suggestions → publish_comment" (the shim already forces gfm_markdown=True),
 * so explicitly kill two defaults and redirect the output to improve.md:
 * - PR_CODE_SUGGESTIONS__COMMITABLE_CODE_SUGGESTIONS=false: committable/inline would go through publish_code_suggestions →
 *   local provider throws NotImplementedError outright (pr-agent's default is already false, this guards against upstream flipping the default).
 * - PR_CODE_SUGGESTIONS__PERSISTENT_COMMENT=false: persistent_comment (default true) would look through history comments for incremental updates →
 *   local provider doesn't implement it and spews a NotImplementedError traceback each time (caught by a fallback, the body isn't lost but the log is noisy); local always
 *   uses a brand-new worktree with no history to look through, so turn it off outright and go through publish_comment.
 * - LOCAL__REVIEW_PATH=improve.md: split from /review /ask's review.md (pr-agent's native local.review_path overrides
 *   the publish_comment on-disk path, with the relative path resolved against the subprocess cwd = worktree root).
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
    // Upper limit on the number of code suggestions (the user's "code suggestion count" setting); if empty, uses pr-agent's default (num_code_suggestions=4).
    if (opts.maxCodeSuggestions !== undefined) {
      env['PR_CODE_SUGGESTIONS__NUM_CODE_SUGGESTIONS'] = String(opts.maxCodeSuggestions);
    }
  }
  // Upper limit on the number of review findings (shares the same setting as /improve); if empty, uses pr-agent's default (num_max_findings=3).
  if (opts.tool === 'review' && opts.maxCodeSuggestions !== undefined) {
    env['PR_REVIEWER__NUM_MAX_FINDINGS'] = String(opts.maxCodeSuggestions);
  }
  return env;
}
