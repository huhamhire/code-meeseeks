"""Offline CLI profile contract tests. Run with embedded Python -B -S to avoid installed shim imports."""
import asyncio
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pragent-shim"))
from meebox_pragent_shim.cli.args import command_prefix, profile_args
from meebox_pragent_shim.cli.install import run_cli_chat


class CliArgumentsTest(unittest.TestCase):
    def test_invalid_arguments(self):
        for value in ['{}', 'null', '[1]', 'not json', '["--json"]', '["exec"]',
                      '["--model"]', '["-c", "sandbox_mode=unsafe"]', '["-c", "model="]']:
            with self.subTest(value=value), patch.dict(os.environ, {"MEEBOX_CLI_ARGS": value}):
                with self.assertRaises(RuntimeError):
                    profile_args("codex")

    def invoke(self, command, args, low=False):
        captured = {}

        class Process:
            returncode = 0

            async def communicate(self, prompt):
                captured["prompt"] = prompt
                if command == "codex":
                    return json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "OK"}}).encode(), b""
                return b'{"result":"OK"}', b""

        async def spawn(*argv, **kwargs):
            captured.update(argv=argv, **kwargs)
            return Process()

        env = {"MEEBOX_CLI_ARGS": json.dumps(args), "MEEBOX_CLI_REASONING": "low" if low else "", "MEEBOX_CLI_WORKDIR": "", "OPENAI_API_KEY": "test-only", "CODEX_API_KEY": "test-only"}
        with patch.dict(os.environ, env), patch("meebox_pragent_shim.cli.install._resolve_cli_exe", return_value=("native-cli", False)), patch("asyncio.create_subprocess_exec", spawn):
            self.assertEqual(asyncio.run(run_cli_chat(command, "system", "user")), "OK")
        return captured

    def test_codex_args_and_precedence(self):
        result = self.invoke("codex", ["--model=custom", "-c", "model_reasoning_effort=medium"], low=True)
        argv = result["argv"]
        self.assertEqual(argv[-4:], ("--model=custom", "-c", "model_reasoning_effort=medium", "-"))
        self.assertNotIn("model_reasoning_effort=low", argv)
        self.assertIn("--json", argv)
        self.assertIn("read-only", argv)
        self.assertEqual(result["cwd"], tempfile.gettempdir())
        self.assertEqual(result["prompt"], b"system\n\n\nuser")
        self.assertNotIn("OPENAI_API_KEY", result["env"])
        self.assertNotIn("CODEX_API_KEY", result["env"])

    def test_defaults_and_claude_explicit_preferences(self):
        self.assertIn("model_reasoning_effort=low", self.invoke("codex", ["-m", "custom"], low=True)["argv"])
        self.assertNotIn("model_reasoning_effort=low", self.invoke("codex", [], low=False)["argv"])
        for args in [["--model", "sonnet"], ["--effort=medium"]]:
            self.assertNotIn("haiku", self.invoke("claude", args, low=True)["argv"])
        self.assertIn("haiku", self.invoke("claude", [], low=True)["argv"])

    def test_windows_npm_launcher_and_batch_metacharacters(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as tmp:
            root = Path(tmp)
            script = root / "node_modules/@openai/codex/bin/codex.js"
            script.parent.mkdir(parents=True)
            script.touch()
            (root / "node.exe").touch()
            exe = str(root / "codex.cmd")
            self.assertEqual(command_prefix(exe, True, "codex", ['--model', 'a&b']), [str(root / "node.exe"), str(script)])
            script.unlink()
            with self.assertRaises(RuntimeError):
                command_prefix(exe, True, "codex", ["--model", "a&b"])
            self.assertEqual(command_prefix(exe, True, "codex", ["--model", "plain"]), ["cmd", "/d", "/c", exe])

    def test_bad_arguments_emit_an_error_before_spawn(self):
        stderr = io.StringIO()
        with patch.dict(os.environ, {"MEEBOX_CLI_ARGS": '["--json"]'}), patch("asyncio.create_subprocess_exec") as spawn, contextlib.redirect_stderr(stderr):
            with self.assertRaises(RuntimeError):
                asyncio.run(run_cli_chat("codex", "", "test"))
        spawn.assert_not_called()
        self.assertIn("@@MEEBOX_LLM_ERROR@@", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
