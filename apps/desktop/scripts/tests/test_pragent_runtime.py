"""Offline integration checks against the assembled runtime, invoked by prepare:pragent."""
import asyncio
import contextlib
import importlib.metadata
import io
import json
import os
import socket
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

# Configure before importing pr-agent: exercise its real environment loader and lazy shim hooks.
os.environ.pop("MEEBOX_CLI_MODE", None)
os.environ.update({
    "LITELLM_LOCAL_MODEL_COST_MAP": "True",
    "CONFIG__GIT_PROVIDER": "local",
    "CONFIG__MODEL": "gpt-3.5-turbo",
    "CONFIG__FALLBACK_MODELS": "[]",
    "CONFIG__MAX_MODEL_TOKENS": "128000",
    "CONFIG__CUSTOM_MODEL_MAX_TOKENS": "128000",
    "OPENAI_API_KEY": "sk-offline-test",
    "OPENAI__KEY": "sk-offline-test",
    "ANTHROPIC_API_KEY": "sk-offline-test",
    "ANTHROPIC__KEY": "sk-offline-test",
    "PR_REVIEWER__PERSISTENT_FINDING_STATE": "false",
    "PR_REVIEWER__ENABLE_REVIEW_COVERAGE_FOOTER": "false",
    "PR_CODE_SUGGESTIONS__ENABLE_SUGGESTIONS_COVERAGE_FOOTER": "false",
    "PR_CODE_SUGGESTIONS__COMMITTABLE_CODE_SUGGESTIONS": "false",
    "PR_CODE_SUGGESTIONS__PERSISTENT_COMMENT": "false",
    "PR_DESCRIPTION__PR_DIAGRAM_DIRECTION": "LR",
})


class RuntimeCompatibilityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        original_connect = socket.socket.connect

        def offline_connect(sock, address):
            # Windows asyncio uses a loopback socket pair for its event loop.
            if isinstance(address, tuple) and address[0] in ("127.0.0.1", "::1"):
                return original_connect(sock, address)
            raise AssertionError("Offline test attempted network access")

        cls.network_guard = patch("socket.socket.connect", offline_connect)
        cls.network_guard.start()

    @classmethod
    def tearDownClass(cls):
        cls.network_guard.stop()

    def test_version_defaults_and_single_model_retry(self):
        from meebox_pragent_shim.runtime import _EXPECTED_PRAGENT_VERSION
        from pr_agent.config_loader import get_settings
        from pr_agent.algo.pr_processing import _get_all_models, retry_with_fallback_models

        self.assertEqual(importlib.metadata.version("pr-agent"), _EXPECTED_PRAGENT_VERSION)
        settings = get_settings()
        self.assertEqual(settings.config.fallback_models, [])
        self.assertEqual(_get_all_models(), ["gpt-3.5-turbo"])
        self.assertFalse(settings.pr_reviewer.persistent_finding_state)
        self.assertFalse(settings.pr_reviewer.enable_review_coverage_footer)
        self.assertFalse(settings.pr_code_suggestions.enable_suggestions_coverage_footer)
        self.assertFalse(settings.pr_code_suggestions.committable_code_suggestions)
        self.assertEqual(settings.pr_description.pr_diagram_direction, "LR")
        call = AsyncMock(side_effect=RuntimeError("synthetic provider failure"))
        with self.assertRaises(Exception):
            asyncio.run(retry_with_fallback_models(call))
        self.assertEqual(call.await_count, 1)

    def test_local_provider_committed_context_diff_and_files(self):
        from git import Actor, Repo
        from pr_agent.git_providers.local_git_provider import LocalGitProvider

        with tempfile.TemporaryDirectory() as tmp, contextlib.chdir(tmp):
            root = Path(tmp)
            repo = Repo.init(root)
            actor = Actor("Runtime test", "runtime-test@example.invalid")
            (root / "sample.py").write_text("value = 1\n", encoding="utf-8")
            (root / "AGENTS.md").write_text("Trusted base instructions\n", encoding="utf-8")
            (root / "binary.bin").write_bytes(b"\xff\xfe\0")
            repo.index.add(["sample.py", "AGENTS.md", "binary.bin"])
            repo.index.commit("Fixture base", author=actor, committer=actor)
            repo.create_head("base")
            (root / "sample.py").write_text("value = 2\n", encoding="utf-8")
            (root / "AGENTS.md").write_text("Untrusted head instructions\n", encoding="utf-8")
            (root / "binary.bin").write_bytes(b"\xff\xfe\1")
            repo.index.add(["sample.py", "AGENTS.md", "binary.bin"])
            repo.index.commit("Fixture head", author=actor, committer=actor)
            # /ask sanitizes tracked instructions, so repository preparation must tolerate dirty files.
            (root / "AGENTS.md").write_text("", encoding="utf-8")
            provider = LocalGitProvider("base")
            self.assertEqual(provider.get_repo_file_content("AGENTS.md", True).splitlines(), ["Trusted base instructions"])
            self.assertEqual(provider.get_repo_file_content("missing.md"), "")
            files = provider.get_diff_files()
            self.assertNotIn("binary.bin", [file.filename for file in files])
            sample = next(file for file in files if file.filename == "sample.py")
            self.assertEqual((sample.num_plus_lines, sample.num_minus_lines), (1, 1))
            self.assertEqual(provider.get_line_link("a b.py", 2, 3), "meebox:///a%20b.py#L2-L3")
            self.assertEqual(provider.get_line_link("sample.py", -1), "meebox:///sample.py")
            self.assertEqual(provider.get_pr_labels(), [])
            self.assertTrue(provider.is_supported("gfm_markdown"))
            provider.publish_description("Title", "Description fixture")
            provider.publish_comment("Review fixture")
            self.assertIn("Description fixture", (root / "description.md").read_text("utf-8"))
            self.assertIn("Review fixture", (root / "review.md").read_text("utf-8"))
            provider.repo.close()
            repo.close()

    def test_description_assessment_and_output_validation(self):
        from pr_agent.config_loader import get_settings
        from pr_agent.tools.pr_description import PRDescription
        from pr_agent.git_providers.local_git_provider import LocalGitProvider

        self.assertIn("assessment: str", get_settings().pr_description_prompt.system)
        data = {"title": "Fixture", "type": ["Enhancement"], "description": "- Change", "assessment": "Alternative approaches"}
        self.assertTrue(PRDescription._validate_description_schema(data))
        tool = object.__new__(PRDescription)
        tool.data = dict(data)
        tool.vars = {"title": "Fixture"}
        tool.git_provider = object.__new__(LocalGitProvider)
        _, body, _ = tool._prepare_pr_answer()
        self.assertIn("### **Assessment**", body)
        self.assertIn("Alternative approaches", body)

    def test_yaml_repair_and_review_schema(self):
        from pr_agent.algo.utils import load_yaml
        from pr_agent.algo.output_models import PRReview, PRCodeSuggestions

        text = 'review:\n[file: sample.py#L1]\n  key_issues_to_review: []\n'
        data = load_yaml(text)
        self.assertEqual(data, {"review": {"key_issues_to_review": []}})
        PRReview.model_validate(data)
        PRCodeSuggestions.model_validate({"code_suggestions": []})

    def test_tool_outputs_stay_local_and_keep_markdown_contracts(self):
        from git import Actor, Repo
        import yaml
        from pr_agent.config_loader import get_settings
        from pr_agent.tools.pr_description import PRDescription
        from pr_agent.tools.pr_questions import PRQuestions
        from pr_agent.tools.pr_code_suggestions import PRCodeSuggestions
        from pr_agent import cli
        from pr_agent.agent.pr_agent import PRAgent

        calls = []

        class FakeHandler:
            def __init__(self, answer):
                self.answer = answer

            async def chat_completion(self, model, system, user, **kwargs):
                calls.append(model)
                if "PRCodeSuggestionsFeedback" in system:
                    answer = {"code_suggestions": [{"suggestion_summary": "Check the fixture value", "relevant_file": "sample.py", "relevant_lines_start": 1, "relevant_lines_end": 1, "suggestion_score": 8, "why": "Synthetic test finding"}]}
                    return yaml.safe_dump(answer), "stop"
                return self.answer, "stop"

        description = yaml.safe_dump({"title": "Fixture title", "type": ["Enhancement"], "description": "- Update fixture", "assessment": "Fixture alternative", "pr_files": [{"filename": "sample.py", "changes_title": "Update value", "changes_summary": "Change the fixture value", "label": "enhancement"}]})
        marker = '[review-priority: {"level":"P2","trigger":"fixture runs","consequence":"value changes"}]'
        review = yaml.safe_dump({"review": {"estimated_effort_to_review_[1-5]": 1, "relevant_tests": "Yes", "security_concerns": "No", "key_issues_to_review": [{"relevant_file": "sample.py", "issue_header": "Fixture issue", "issue_content": f"Synthetic issue for the upgrade regression\n{marker}", "start_line": 1, "end_line": 1}]}})
        suggestions = yaml.safe_dump({"code_suggestions": [{"relevant_file": "sample.py", "language": "python", "existing_code": "value = 2", "improved_code": "value = 3", "suggestion_content": "Check the fixture value", "one_sentence_summary": "Check the fixture value", "label": "possible bug"}]})
        settings = get_settings()
        with tempfile.TemporaryDirectory() as tmp, contextlib.chdir(tmp):
            root = Path(tmp)
            repo = Repo.init(root)
            actor = Actor("Runtime test", "runtime-test@example.invalid")
            source = root / "sample.py"
            source.write_text("value = 1\n", encoding="utf-8")
            repo.index.add(["sample.py"])
            repo.index.commit("Fixture base", author=actor, committer=actor)
            repo.create_head("base")
            source.write_text("value = 2\n", encoding="utf-8")
            repo.index.add(["sample.py"])
            repo.index.commit("Fixture head", author=actor, committer=actor)
            settings.config.publish_output_progress = False
            try:
                asyncio.run(PRDescription("base", ai_handler=lambda: FakeHandler(description)).run())
                body = (root / "description.md").read_text("utf-8")
                self.assertIn("Fixture alternative", body)
                self.assertIn("File Walkthrough", body)
                artifact = root / "structured-review.json"
                markdown = root / "local-review-output.md"
                env_probe = subprocess.run(
                    [sys.executable, "-B", "-c", "from pr_agent.config_loader import get_settings; print(get_settings().get('local.review_path'))"],
                    env=dict(os.environ, LOCAL__REVIEW_PATH=str(markdown)),
                    capture_output=True, text=True, timeout=30, check=True,
                )
                self.assertEqual(env_probe.stdout.strip(), str(markdown))
                settings.set("local.review_path", str(markdown))
                with patch.object(
                    cli, "PRAgent", lambda: PRAgent(ai_handler=lambda: FakeHandler(review))
                ):
                    cli.run(["--pr_url", "base", "--json-output", str(artifact), "review"])
                structured = json.loads(artifact.read_text("utf-8"))
                self.assertEqual(structured["review"]["key_issues_to_review"][0]["start_line"], 1)
                self.assertIn(marker, structured["review"]["key_issues_to_review"][0]["issue_content"])
                self.assertEqual(structured["coverage"], {"files_not_reviewed": [], "files_partially_reviewed": []})
                body = markdown.read_text("utf-8")
                self.assertIn("Fixture issue", body)
                self.assertIn(marker, body)
                self.assertIn("meebox:///sample.py#L1", body)
                settings.set("local.review_path", None)
                asyncio.run(PRQuestions("base", args=["What changed?"], ai_handler=lambda: FakeHandler("Fixture answer")).run())
                self.assertIn("Fixture answer", (root / "review.md").read_text("utf-8"))
                settings.set("local.review_path", str(root / "improve.md"))
                asyncio.run(PRCodeSuggestions("base", ai_handler=lambda: FakeHandler(suggestions)).run())
                self.assertIn("Check the fixture value", (root / "improve.md").read_text("utf-8"))
                self.assertGreaterEqual(len(calls), 5)
            finally:
                settings.set("local.review_path", None)
                repo.close()

    def test_api_completion_usage_cache_and_temperature(self):
        from litellm import ModelResponse
        from pr_agent.algo.ai_handlers.litellm_ai_handler import LiteLLMAIHandler

        handler = LiteLLMAIHandler()
        response = ModelResponse(choices=[{"message": {"role": "assistant", "content": "Offline reply"}, "finish_reason": "stop"}], usage={"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15})
        call = AsyncMock(return_value=response)
        stderr = io.StringIO()
        with patch.object(handler, "_acompletion", call), contextlib.redirect_stderr(stderr):
            result = asyncio.run(handler.chat_completion(model="anthropic/claude-opus-4-8", system="Stable system " * 400, user="Offline question"))
        self.assertEqual(result, ("Offline reply", "stop"))
        self.assertNotIn("temperature", call.call_args.kwargs)
        messages = call.call_args.kwargs["messages"]
        self.assertEqual(messages[0]["content"][0]["cache_control"]["type"], "ephemeral")
        line = next(line for line in stderr.getvalue().splitlines() if "@@MEEBOX_USAGE@@" in line)
        usage = json.loads(line.split("@@MEEBOX_USAGE@@", 1)[1])
        self.assertEqual(usage["total_tokens"], 15)

    def test_cli_override_with_actual_handler(self):
        # Import in a fresh process so the real lazy hook selects CLI mode instead of the API wrapper.
        code = """
import asyncio
from unittest.mock import AsyncMock, patch
from pr_agent.algo.ai_handlers.litellm_ai_handler import LiteLLMAIHandler
call = AsyncMock(return_value="Offline CLI reply")
with patch("meebox_pragent_shim.cli.install.run_cli_chat", call):
    result = asyncio.run(LiteLLMAIHandler().chat_completion(
        model="synthetic-pr-agent-label", system="system", user="user"))
    assert result == ("Offline CLI reply", "stop"), result
    call.assert_awaited_once_with("codex", "system", "user")
print("CLI_OVERRIDE_OK")
"""
        env = dict(os.environ, MEEBOX_CLI_MODE="1", MEEBOX_CLI_BIN="codex", MEEBOX_CLI_ARGS="[]")
        result = subprocess.run([sys.executable, "-B", "-c", code], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("CLI_OVERRIDE_OK", result.stdout)


if __name__ == "__main__":
    unittest.main()
