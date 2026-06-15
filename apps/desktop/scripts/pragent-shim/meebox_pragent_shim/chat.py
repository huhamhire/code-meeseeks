"""编排器「独立 LLM 对话通道」的运行入口（见 docs/arch/06-agent.md §3 + packages/pr-agent-bridge）。

由嵌入式运行时以 `python -m meebox_pragent_shim.chat` 启动：复用 pr-agent **已被本 shim 补丁**的
`LiteLLMAIHandler.chat_completion`——provider 路由、CLI 模式（MEEBOX_CLI_MODE）、Anthropic 去
temperature、token usage 哨兵全部继承，无需在此重复实现。

约定：stdin 收一段 JSON `{"system": ..., "user": ..., "temperature"?: ...}`，回复正文写 stdout，
token 用量经 `@@MEEBOX_USAGE@@` 哨兵打到 stderr（主进程与 pr-agent run 同一套累加，见 ipc.ts）。
"""
import asyncio
import json
import sys


def _read_payload() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        return {"system": "", "user": "", "temperature": None}
    data = json.loads(raw)
    return {
        "system": data.get("system") or "",
        "user": data.get("user") or "",
        "temperature": data.get("temperature"),
    }


async def _run(payload: dict) -> str:
    # 惰性 import：触发 shim 注册的 post-import 补丁（CLI 模式替换 / _get_completion usage 包装）。
    from pr_agent.algo.ai_handlers.litellm_ai_handler import LiteLLMAIHandler
    from pr_agent.config_loader import get_settings

    model = get_settings().config.model
    handler = LiteLLMAIHandler()
    kwargs = {"model": model, "system": payload["system"], "user": payload["user"]}
    if payload["temperature"] is not None:
        kwargs["temperature"] = payload["temperature"]
    result = await handler.chat_completion(**kwargs)
    # chat_completion 返回 (resp_text, finish_reason)
    if isinstance(result, tuple):
        return result[0] or ""
    return result or ""


def main() -> int:
    try:
        text = asyncio.run(_run(_read_payload()))
        sys.stdout.write(text)
        sys.stdout.flush()
        return 0
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"meebox_chat error: {exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
