"""Run entry for the orchestrator's "standalone LLM chat channel" (see docs/arch/02-agent/01-agent.md §3 + packages/pr-agent-bridge).

Launched by the embedded runtime as `python -m meebox_pragent_shim.chat`, splitting into two paths by provider:

  - **CLI mode** (MEEBOX_CLI_MODE set, local claude / codex): calls `cli.run_cli_chat` directly, **without importing
    pr_agent / litellm**. The CLI path's real calls already bypass litellm (see cli/install.py); this avoids each chat subprocess
    paying the full pr_agent + litellm import cost just to obtain an unused LiteLLMAIHandler -- orchestration has its own steps (routing /
    judge / summary) invoked multiple times per flow, which adds up considerably.

  - **API mode** (anthropic / openai / deepseek ...): litellm is the HTTP client and cannot be bypassed, so reuse pr-agent's
    `LiteLLMAIHandler.chat_completion` **already patched by this shim** -- provider routing, Anthropic temperature removal,
    prompt caching, and the token usage sentinel are all inherited, no need to reimplement here.

Convention: stdin receives a JSON blob `{"system": ..., "user": ..., "temperature"?: ..., "max_output_tokens"?: ...}`,
the reply body is written to stdout, and token usage is emitted to stderr via the `@@MEEBOX_USAGE@@` sentinel (the main process uses
the same accumulation as a pr-agent run, see ipc.ts). max_output_tokens caps output (for lightweight routing decisions), relayed via env
to the litellm_handler patch which injects litellm max_tokens -- only effective on the embedded litellm path; CLI providers ignore it
(their reasoning tier is controlled by MEEBOX_CLI_REASONING).
"""
import asyncio
import json
import os
import sys


def _read_payload() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        return {"system": "", "user": "", "temperature": None, "max_output_tokens": None}
    data = json.loads(raw)
    return {
        "system": data.get("system") or "",
        "user": data.get("user") or "",
        "temperature": data.get("temperature"),
        "max_output_tokens": data.get("max_output_tokens"),
    }


async def _run(payload: dict) -> str:
    # CLI mode short-circuit: call the local CLI directly, bypass litellm, and don't import pr_agent -- saving the full import cost.
    # model / temperature / max_output_tokens are unused on the CLI path (command and reasoning tier are decided by spec + MEEBOX_CLI_*
    # env), so just ignore them.
    if os.environ.get("MEEBOX_CLI_MODE"):
        from .cli.install import run_cli_chat

        bin_name = (os.environ.get("MEEBOX_CLI_BIN") or "claude").strip() or "claude"
        return await run_cli_chat(bin_name, payload["system"], payload["user"])

    # Output cap: each chat is its own subprocess, so setting the env var is "this call" scoped -- the _get_completion
    # wrapper in the litellm_handler patch reads it to inject litellm max_tokens (see patches/litellm_handler).
    mot = payload.get("max_output_tokens")
    if isinstance(mot, int) and mot > 0:
        os.environ["MEEBOX_CHAT_MAX_TOKENS"] = str(mot)

    # Lazy import: triggers the post-import patches registered by the shim (_get_completion usage wrap / prompt caching / temperature removal).
    from pr_agent.algo.ai_handlers.litellm_ai_handler import LiteLLMAIHandler
    from pr_agent.config_loader import get_settings

    model = get_settings().config.model
    handler = LiteLLMAIHandler()
    kwargs = {"model": model, "system": payload["system"], "user": payload["user"]}
    if payload["temperature"] is not None:
        kwargs["temperature"] = payload["temperature"]
    result = await handler.chat_completion(**kwargs)
    # chat_completion returns (resp_text, finish_reason)
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
