"""Real token usage collection: emitted to stderr as a sentinel line `@@MEEBOX_USAGE@@ {json}`, which the main process onLine
accumulates from (see apps/desktop/src/main/ipc.ts). Takes only tokens, not cost. Fault-tolerant throughout."""
import sys

from .runtime import _debug


def _emit_usage(response) -> None:
    """Read **real usage** from the litellm response (API-returned, not estimated). Called by the litellm handler's
    _get_completion wrapper."""
    try:
        usage = getattr(response, "usage", None)
        if usage is None and isinstance(response, dict):
            usage = response.get("usage")
        if usage is None:
            return

        def _g(key):
            return usage.get(key) if isinstance(usage, dict) else getattr(usage, key, None)

        import json

        rec = {
            "prompt_tokens": _g("prompt_tokens"),
            "completion_tokens": _g("completion_tokens"),
            "total_tokens": _g("total_tokens"),
        }
        if rec["prompt_tokens"] is None and rec["completion_tokens"] is None:
            return  # no usable numbers at all (e.g. streaming MockResponse) → don't emit
        # Prompt cache read amount: Anthropic uses cache_read_input_tokens; OpenAI-compatible uses
        # prompt_tokens_details.cached_tokens. Best-effort collection on both paths, omitted if missing (UI decides whether to display based on presence).
        cache_read = _g("cache_read_input_tokens")
        if not isinstance(cache_read, int):
            details = _g("prompt_tokens_details")
            if details is not None:
                cache_read = (
                    details.get("cached_tokens")
                    if isinstance(details, dict)
                    else getattr(details, "cached_tokens", None)
                )
        if isinstance(cache_read, int):
            rec["cache_read_tokens"] = cache_read
        print(f"@@MEEBOX_USAGE@@ {json.dumps(rec)}", file=sys.stderr, flush=True)
    except Exception as exc:  # noqa: BLE001
        _debug(f"emit usage failed (ignored): {exc}")


def _emit_usage_tokens(
    prompt_tokens, completion_tokens, cache_read_tokens=None, turns=None
) -> None:
    """In CLI mode, construct the sentinel directly from the CLI-returned JSON usage (same format as _emit_usage, same
    accumulation logic in the main process). Doesn't emit if both token counts are None; cache_read / turns are attached only when present."""
    try:
        if prompt_tokens is None and completion_tokens is None:
            return
        import json

        rec = {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": (prompt_tokens or 0) + (completion_tokens or 0),
        }
        if cache_read_tokens is not None:
            rec["cache_read_tokens"] = cache_read_tokens
        if turns is not None:
            rec["turns"] = turns
        print(f"@@MEEBOX_USAGE@@ {json.dumps(rec)}", file=sys.stderr, flush=True)
    except Exception as exc:  # noqa: BLE001
        _debug(f"emit cli usage failed (ignored): {exc}")
