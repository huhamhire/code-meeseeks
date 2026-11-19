"""Validate profile arguments and preserve the application's subprocess protocol."""
import json
import os


# Keep in sync with packages/shared/src/cli-args.ts.
_VALUE_OPTIONS = {
    "codex": {"--model", "-m", "--config", "-c"},
    "claude": {"--model", "--effort", "--max-turns", "--max-budget-usd", "--fallback-model"},
}
_CONFIG_KEYS = {"model", "model_reasoning_effort", "service_tier", "model_verbosity"}


def profile_args(name):
    """Read a JSON argv array, returning it and whether the low-effort default is overridden."""
    try:
        args = json.loads(os.environ.get("MEEBOX_CLI_ARGS", "[]"))
    except (ValueError, TypeError) as exc:
        raise RuntimeError("Invalid local CLI arguments: expected a JSON array") from exc
    if not isinstance(args, list) or any(not isinstance(arg, str) for arg in args):
        raise RuntimeError("Invalid local CLI arguments: expected a string array")
    overridden = False
    i = 0
    while i < len(args):
        option, equals, value = args[i].partition("=")
        if option not in _VALUE_OPTIONS.get(name, set()):
            raise RuntimeError("Unsupported or application-managed local CLI argument")
        if not equals:
            i += 1
            value = args[i] if i < len(args) else ""
        if not value or value.startswith("-") or any(c in value for c in "\0\r\n"):
            raise RuntimeError("Missing or invalid local CLI argument value")
        if option in ("-c", "--config"):
            key, separator, setting = value.partition("=")
            if key.strip() not in _CONFIG_KEYS or not separator or not setting.strip():
                raise RuntimeError("Unsupported or application-managed local CLI configuration key")
            if key.strip() == "model_reasoning_effort":
                overridden = True
        if name == "claude" and option in ("--model", "--effort"):
            overridden = True
        i += 1
    return args, overridden


def command_prefix(exe, needs_cmd, name, args):
    """Prefer the npm JS entry point on Windows so argument values never pass through cmd.exe."""
    if not needs_cmd:
        return [exe]
    import pathlib
    import shutil

    scripts = {"codex": "@openai/codex/bin/codex.js", "claude": "@anthropic-ai/claude-code/cli.js"}
    script = pathlib.Path(exe).parent / "node_modules" / scripts[name]
    node = pathlib.Path(exe).parent / "node.exe"
    node_exe = str(node) if node.is_file() else shutil.which("node")
    if script.is_file() and node_exe:
        return [node_exe, str(script)]
    # Custom batch launchers remain supported for plain values. Reject cmd expansion and quote escapes.
    if any(any(c in arg for c in '\"%!^&|<>\r\n') for arg in args):
        raise RuntimeError("CLI arguments containing shell metacharacters require a native or npm CLI launcher")
    return ["cmd", "/d", "/c", exe]
