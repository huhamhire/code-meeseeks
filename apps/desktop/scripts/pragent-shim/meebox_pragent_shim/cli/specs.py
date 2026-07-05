"""Spec table for adapted local CLI commands: argv flags (the prompt always goes via stdin) + output parser + billing env to strip.
Registering one entry here is enough for a new command; the renderer-side whitelist validation must stay in sync (see LlmProfileForm.validateProfile)."""
from .parsers import _parse_claude_output, _parse_codex_output

# `low_effort_flags`: argv to append for the low-effort tier (only enabled by the Agent orchestration channel via MEEBOX_CLI_REASONING,
# see install.py). Commands with a trailing `-` (stdin) insert these flags before the `-`, keeping `-` last.
_CLI_SPECS = {
    # claude: -p single-round non-interactive + JSON (one segment containing the result and usage); by default does not pass --model, using the local default model / login state.
    # Low-effort tier: --model haiku (fastest and cheapest, suited to the orchestration channel's routing / interpretation / wrap-up / conversation), differentiated from /review which uses the default
    # model; the haiku alias automatically resolves to the latest haiku available to the current account.
    "claude": {
        "flags": ["-p", "--output-format", "json"],
        "low_effort_flags": ["--model", "haiku"],
        "parser": _parse_claude_output,
        "strip_env": ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"),
    },
    # codex: exec non-interactive + --json (JSONL event stream); the trailing `-` makes stdin the full prompt;
    # --skip-git-repo-check allows running in a temp directory, --sandbox read-only is read-only and does not modify files.
    # Disable web_search / image_gen by default: review and orchestration run in a read-only temp directory where these two tools are unused,
    # turning them off both narrows the tool surface and saves ~3K tokens (tool definitions are no longer sent with each request). Keys:
    #   web_search is a string enum (disabled / cached / live), use `-c web_search=disabled`;
    #   image_gen is a feature flag, use `-c features.image_generation=false` (equivalent to --disable image_generation).
    # Low-effort tier: -c model_reasoning_effort=low (codex reasons heavily by default, the orchestration channel does not need it, lowering it speeds things up).
    # Not using minimal: gpt-5.x-codex does not support minimal (only none/low/medium/high/xhigh, passing minimal returns a 400),
    # and minimal is also mutually exclusive with web_search / image_gen; low is widely supported and tool-compatible, making it more reliable for the low-effort tier.
    "codex": {
        "flags": [
            "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only",
            "-c", "web_search=disabled", "-c", "features.image_generation=false", "-",
        ],
        "low_effort_flags": ["-c", "model_reasoning_effort=low"],
        "parser": _parse_codex_output,
        "strip_env": ("OPENAI_API_KEY", "CODEX_API_KEY"),
    },
}
