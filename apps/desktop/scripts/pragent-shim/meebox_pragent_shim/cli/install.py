"""CLI mode: invoke a local CLI subprocess to run one round of conversation, fully bypassing litellm / the direct API.

Both entry points share the same subprocess logic `run_cli_chat`:
  - `_install_cli_chat_completion`: replaces LiteLLMAIHandler.chat_completion wholesale with a CLI-invoking version,
    called by patches.litellm_handler when MEEBOX_CLI_MODE is set — serves the **pr-agent tool run** (/describe
    /review /ask via `python -m pr_agent.cli`, whose internal LLM calls all go through chat_completion).
  - `run_cli_chat`: the orchestration **chat channel** (`python -m meebox_pragent_shim.chat`) calls it directly in CLI mode,
    with no need to import pr_agent / litellm (the CLI path does not use litellm at all), saving the full import overhead of every chat subprocess.
"""
import os
import sys

from ..runtime import _debug, strip_cache_break
from ..usage import _emit_usage_tokens
from .specs import _CLI_SPECS


def _resolve_cli_exe(bin_name):
    """Resolve the command's real path via shutil.which. On Windows, PATHEXT may match .cmd/.bat (which cannot be
    launched directly by CreateProcess and must go through cmd /c). Returns (exe_path_or_None, needs_cmd_wrapper)."""
    import shutil

    exe = shutil.which(bin_name)
    if not exe:
        return None, False
    needs_cmd = sys.platform == "win32" and exe.lower().endswith((".cmd", ".bat"))
    return exe, needs_cmd


async def run_cli_chat(bin_name, system, user) -> str:
    """Invoke a local CLI subprocess to run one round of system+user conversation, returning the reply body (usage is emitted to stderr via a sentinel).

    pr-agent only depends on the stable contract that chat_completion returns (text, finish_reason) (defined by base_ai_handler),
    so the CLI takeover is independent of the specific pr-agent version and **not subject to the version guard** (unlike other patches that depend on internal implementation). This function
    is self-contained and does not import pr_agent / litellm; the orchestration chat channel can call it directly in CLI mode to save the full import overhead.

    Per-command differences (argv flags / output parsing / billing env to strip) are centralized in _CLI_SPECS, looked up by command name:
      - The prompt is fed via **stdin**: the review prompt contains the full diff (tens of KB), and passing it via argv would hit the command-line length limit;
        system / user are concatenated into one segment (a single CLI round has no separate system slot).
      - cwd defaults to a neutral temp directory: to avoid picking up context from the repo under review (CLAUDE.md / AGENTS.md etc.) that would pollute the output.
        Exception: the main process only passes a (sanitized) worktree path via MEEBOX_CLI_WORKDIR for /ask, so free-form Q&A can read
        the full files; describe/review do not pass this env and keep the neutral temp directory. Sanitization is done on the main-process side (clearing the repo's own instruction files).
      - The subprocess inherits the parent env (PATH / HOME / proxy variables), so it can find the command, reuse its login state, and route outbound traffic through the proxy automatically.
      - **Credential isolation**: strip the corresponding billing key (claude: ANTHROPIC_*; codex: OPENAI_API_KEY / CODEX_API_KEY),
        so the CLI uses its own login session rather than an API key lingering in the environment. The model and quota are determined by that CLI account and the user's authorization.
    """
    import asyncio
    import tempfile

    name = (bin_name or "").strip().lower()
    spec = _CLI_SPECS.get(name)
    if spec is None:
        raise RuntimeError(
            f"unsupported local CLI command '{bin_name}' (currently adapted: claude / codex)."
        )
    exe, needs_cmd = _resolve_cli_exe(bin_name)
    # Command prefix (cmd wrapper + exe); None if exe resolution failed.
    cmd_prefix = (["cmd", "/c", exe] if needs_cmd else [exe]) if exe else None
    if cmd_prefix is None:
        raise RuntimeError(
            f"local CLI command '{bin_name}' not found: please confirm it is installed, logged in, and that '{bin_name}' is on PATH."
        )

    # Low-effort tier: only the Agent orchestration channel enables it via MEEBOX_CLI_REASONING=low/minimal; insert low_effort_flags
    # before the trailing `-` (stdin placeholder), keeping `-` last; if there is no trailing `-`, just append.
    flags = list(spec["flags"])
    if os.environ.get("MEEBOX_CLI_REASONING", "").strip().lower() in ("low", "minimal"):
        extra = list(spec.get("low_effort_flags") or [])
        if extra:
            flags = flags[:-1] + extra + ["-"] if flags and flags[-1] == "-" else flags + extra
    argv = cmd_prefix + flags

    # A single CLI round has no separate system slot: concatenate system+user into one segment. First strip cache-break markers (used only by the Anthropic litellm path for
    # chunked caching; the CLI does not cache, and the markers must not enter the prompt).
    system = strip_cache_break(system) if system else system
    prompt = f"{system}\n\n\n{user}" if system else user
    # Copy from os.environ then remove the billing keys — everything else (PATH/HOME/proxy variables, etc.) is kept as-is.
    child_env = {k: v for k, v in os.environ.items() if k not in spec["strip_env"]}
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=(os.environ.get("MEEBOX_CLI_WORKDIR") or "").strip() or tempfile.gettempdir(),
            env=child_env,
        )
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"failed to start CLI '{bin_name}': {exc}") from exc
    out, err = await proc.communicate(prompt.encode("utf-8"))
    if proc.returncode != 0:
        raise RuntimeError(
            f"CLI '{bin_name}' exit code {proc.returncode}: "
            f"{(err or b'').decode('utf-8', 'replace')[:500]}"
        )
    text, usage = spec["parser"]((out or b"").decode("utf-8", "replace"))
    if usage:
        # prompt_tokens ≈ total input-side size, output_tokens ≈ completion (input/output_tokens share the same names across both).
        # The cache fields differ in convention between the two:
        #   - Anthropic(claude): input_tokens **excludes** cache, so cache_read/creation must be added into the total;
        #     cache_read uses cache_read_input_tokens.
        #   - OpenAI(codex): input_tokens **already includes** cache, and cached_input_tokens is only the hit count, not counted into the total again.
        prompt_tokens = usage.get("input_tokens")
        for k in ("cache_read_input_tokens", "cache_creation_input_tokens"):
            v = usage.get(k)
            if isinstance(v, int):
                prompt_tokens = (prompt_tokens or 0) + v
        cache_read = usage.get("cache_read_input_tokens")
        if not isinstance(cache_read, int):
            cache_read = usage.get("cached_input_tokens")  # codex/OpenAI style
        turns = usage.get("num_turns")
        _emit_usage_tokens(
            prompt_tokens,
            usage.get("output_tokens"),
            cache_read_tokens=cache_read if isinstance(cache_read, int) else None,
            turns=turns if isinstance(turns, int) else None,
        )
    return text


def _install_cli_chat_completion(handler_cls, bin_name) -> None:
    """Replace chat_completion with a version that invokes a local CLI subprocess (delegating to run_cli_chat), serving the pr-agent tool run.
    chat_completion's model / temperature / img_path are unused on the CLI path (the command and effort tier are determined by spec + env);
    they are kept only to satisfy base_ai_handler's method signature."""

    async def chat_completion(self, model, system, user, temperature=0.2, img_path=None):
        text = await run_cli_chat(bin_name, system, user)
        return text, "stop"

    handler_cls.chat_completion = chat_completion
    _debug(f"installed CLI chat_completion via '{bin_name}'")
