"""litellm handler patch (merged into one patch_fn; registering multiple finders on the same module would shadow each other):
  (0) CLI mode (MEEBOX_CLI_MODE set): swap chat_completion to call the local CLI directly, bypassing litellm, then
      return. This branch runs before the version guard and is not bound to the pr-agent version.
  (1) Drop temperature for new Anthropic models (pinned version only).
  (2) Wrap _get_completion to inline-collect real token usage (pinned version only).
"""
import os

from ..cli.install import _install_cli_chat_completion
from ..runtime import (
    _EXPECTED_PRAGENT_VERSION,
    _debug,
    _pragent_version,
    split_cache_break,
)
from ..usage import _emit_usage

# Anthropic prompt caching has a minimum cacheable granularity of ~1k tokens; a stable prefix below this is not marked for caching (including a tiny classification system prompt).
_CACHE_MIN_CHARS = 4000
# Use the 1h extended TTL for the global stable prefix: hits across all PRs/runs within 1h, the 2x write cost amortized by many hits; requires the beta header.
_CACHE_TTL = "1h"
_CACHE_BETA_FLAG = "extended-cache-ttl-2025-04-11"


def _add_cache_beta_header(kwargs: dict) -> None:
    """Merge in the anthropic-beta header required for 1h caching (without overwriting existing flags)."""
    headers = kwargs.get("extra_headers")
    if not isinstance(headers, dict):
        headers = {}
    existing = headers.get("anthropic-beta")
    if not existing:
        headers["anthropic-beta"] = _CACHE_BETA_FLAG
    elif _CACHE_BETA_FLAG not in existing:
        headers["anthropic-beta"] = f"{existing},{_CACHE_BETA_FLAG}"
    kwargs["extra_headers"] = headers


def _apply_system_prompt_cache(kwargs: dict) -> None:
    """Mark cache_control (1h extended TTL) on the stable prefix given to Anthropic as system; and strip the CACHE_BREAK marker in all cases.
    Anthropic prompt caching works by **prefix**, **server-side** (no warm session needed), hitting across all PRs/runs within 1h (2x write amortized by hits).
    Covers two kinds of Anthropic calls:

    1) Orchestrated chat channel (MEEBOX_CHAT_CACHE set, system contains the CACHE_BREAK inserted by assembleSystemContext): split at the breakpoint,
       marking the global stable prefix (SOUL/AGENTS/tools/memory/user) for caching on its own, keeping the PR/run-related tail as plain text.
    2) pr-agent tool run (/review /describe /improve /ask, **no** CACHE_BREAK): system is pr-agent's instructions +
       output format (~12k chars, varies only with config/language/rules, stable across PRs; the variable diff is on the user side), mark the whole thing for caching → under the same config,
       hits across runs within 1h.

    Non-Anthropic (OpenAI/DeepSeek etc.): come with automatic prefix caching, no explicit marking needed, just strip the CACHE_BREAK marker and stitch back to plain text; a prefix
    too small (< _CACHE_MIN_CHARS, e.g. a slim classification system prompt) is not marked either.
    """
    msgs = kwargs.get("messages")
    if not isinstance(msgs, list):
        return
    is_anthropic = (kwargs.get("model") or "").lower().startswith("anthropic/")
    chat_cache_on = bool(os.environ.get("MEEBOX_CHAT_CACHE"))
    for m in msgs:
        if m.get("role") != "system" or not isinstance(m.get("content"), str):
            continue
        stable, variable = split_cache_break(m["content"])
        if stable is not None:
            # has CACHE_BREAK (orchestrated chat): mark stable prefix for caching, tail plain text
            if chat_cache_on and is_anthropic and len(stable) >= _CACHE_MIN_CHARS:
                m["content"] = [
                    {
                        "type": "text",
                        "text": stable,
                        "cache_control": {"type": "ephemeral", "ttl": _CACHE_TTL},
                    },
                    {"type": "text", "text": variable},
                ]
                _add_cache_beta_header(kwargs)
            else:
                # non-anthropic / caching off / prefix too small: strip marker and stitch back to plain text (automatic prefix caching can still hit).
                m["content"] = f"{stable}\n\n---\n\n{variable}"
            return
        # no CACHE_BREAK (pr-agent tool run): Anthropic marks the whole stable system for caching (diff is on the user side, not cached).
        if is_anthropic and len(m["content"]) >= _CACHE_MIN_CHARS:
            m["content"] = [
                {
                    "type": "text",
                    "text": m["content"],
                    "cache_control": {"type": "ephemeral", "ttl": _CACHE_TTL},
                },
            ]
            _add_cache_beta_header(kwargs)
        return


def patch(module) -> None:
    """(1) New first-party Anthropic models (claude-opus-4-8 etc.) deprecate the temperature parameter, but pr-agent
    by default still sends temperature=0.2 → the Anthropic API directly reports "temperature is deprecated for this model",
    failing all review/describe.

    pr-agent only omits temperature for models that **exactly match** an entry in NO_SUPPORT_TEMPERATURE_MODELS, a list that is
    hardcoded and lists only OpenAI o-series/gpt-5 etc., without any new Claude (upstream updates lag). custom_reasoning_model
    could also drop temperature but merges system into user (degrading Claude's system prompt), so it's not used.

    Here we replace the module-global NO_SUPPORT_TEMPERATURE_MODELS with a smart container that "additionally recognizes all
    anthropic/* prefixed models": any model going through first-party anthropic never sends temperature. In LiteLLMAIHandler.__init__,
    `self.no_support_temperature_models = NO_SUPPORT_TEMPERATURE_MODELS` reads the module-global name, so rebinding
    the global takes effect for handlers created afterward; only the membership test is touched, not the system/user merge."""
    # Suppress the decorative hints (ANSI red text) like "Provider List: …" that litellm prints to **stdout**. The orchestrated chat channel uses the subprocess
    # stdout as the model reply: in cost/token accounting, when litellm calls get_llm_provider and fails for a new model not in the local model_cost table (e.g. claude-opus-4-8),
    # it first prints that hint then raises (the error is swallowed upstream, not affecting the final result), but the print has already polluted
    # stdout and leaks into the review summary. Set suppress_debug_info=True to turn off these prints (real usage is collected by our own hook,
    # not dependent on this output). Globally effective, independent of the pr-agent version, so placed before the version guard and CLI branch.
    try:
        import litellm

        litellm.suppress_debug_info = True
    except Exception:  # noqa: BLE001 - litellm not ready etc.; failure of purely decorative suppression is not fatal
        pass
    # (0) CLI mode: swap chat_completion to call the local CLI directly, bypassing litellm. Placed before the version guard,
    # because it only depends on the stable contract of base_ai_handler, unrelated to pr-agent internals. Return once installed.
    if os.environ.get("MEEBOX_CLI_MODE"):
        handler_cls = getattr(module, "LiteLLMAIHandler", None)
        if handler_cls is not None:
            bin_name = (os.environ.get("MEEBOX_CLI_BIN") or "claude").strip() or "claude"
            _install_cli_chat_completion(handler_cls, bin_name)
        return

    installed = _pragent_version()
    if installed != _EXPECTED_PRAGENT_VERSION:
        # version mismatch: the local_git_provider patch has already _warn'd about the overall degradation, so silently skip here to avoid duplicate noise
        _debug(
            f"skip no-temperature patch: pr-agent {installed} != {_EXPECTED_PRAGENT_VERSION}"
        )
        return

    orig = list(getattr(module, "NO_SUPPORT_TEMPERATURE_MODELS", []))

    class _NoTempModels(list):
        def __contains__(self, model) -> bool:
            if list.__contains__(self, model):
                return True
            # our normalizeModel always prepends the anthropic/ prefix for the anthropic provider
            return (model or "").lower().startswith("anthropic/")

    module.NO_SUPPORT_TEMPERATURE_MODELS = _NoTempModels(orig)

    # (2) Real token usage collection: wrap LiteLLMAIHandler._get_completion, take response.usage from its returned
    # (content, finish_reason, response), and inline-print a sentinel to stderr.
    # Don't use litellm's callback —— that fires asynchronously on a background logging worker, and is lost if the CLI exits too fast;
    # here it's inline in pr-agent's await chain, guaranteed to run before process exit, reliable.
    handler_cls = getattr(module, "LiteLLMAIHandler", None)
    if handler_cls is not None and hasattr(handler_cls, "_get_completion"):
        _orig_get_completion = handler_cls._get_completion

        async def _get_completion_with_usage(self, **kwargs):
            # Output cap (set by the orchestrator chat channel via MEEBOX_CHAT_MAX_TOKENS; the pr-agent tool run's env does not include
            # this, so /describe /review are uncapped). When "thinking" is present (Claude extended thinking), don't override its max_tokens
            # (otherwise it would fall below the thinking budget and error); also don't override an already-set max_tokens.
            mt = os.environ.get("MEEBOX_CHAT_MAX_TOKENS")
            if mt and "thinking" not in kwargs and "max_tokens" not in kwargs:
                try:
                    kwargs["max_tokens"] = int(mt)
                except (TypeError, ValueError):
                    _debug(f"ignore invalid MEEBOX_CHAT_MAX_TOKENS={mt!r}")
            _apply_system_prompt_cache(kwargs)
            result = await _orig_get_completion(self, **kwargs)
            try:
                if isinstance(result, tuple) and len(result) >= 3:
                    _emit_usage(result[2])
            except Exception as exc:  # noqa: BLE001
                _debug(f"usage wrap failed (ignored): {exc}")
            return result

        handler_cls._get_completion = _get_completion_with_usage
