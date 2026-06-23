"""真实 token usage 采集：以哨兵行 `@@MEEBOX_USAGE@@ {json}` 打到 stderr，主进程 onLine
据此累加（见 apps/desktop/src/main/ipc.ts）。只取 token、不取 cost。全程容错。"""
import sys

from .runtime import _debug


def _emit_usage(response) -> None:
    """从 litellm response 读**真实 usage**（API 返回，非预估）。供 litellm handler 的
    _get_completion 包装调用。"""
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
            return  # 没有任何可用数字（如流式 MockResponse）→ 不打
        # 提示缓存读取量：Anthropic 走 cache_read_input_tokens；OpenAI 兼容走
        # prompt_tokens_details.cached_tokens。两路尽力采集、缺失则不带（UI 据有无决定是否展示）。
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
    """CLI 模式下从 CLI 返回的 JSON usage 直接构造哨兵（与 _emit_usage 同格式，主进程同一套
    累加逻辑）。两个 token 数都为 None 则不打；cache_read / turns 仅在有值时附带。"""
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
