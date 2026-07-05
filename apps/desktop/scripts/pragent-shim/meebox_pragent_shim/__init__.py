"""meebox embedded runtime monkeypatch shim (split by domain).

Entry point apply() is called by the thin sitecustomize.py, registering all lazy post-import hooks:
patches are only applied when the target pr_agent module is actually imported (= a real run).
**Never eager import pr_agent here** -- every module in this package imports pr_agent inside the
patch function body (lazily), so importing this package does not trigger pr_agent load.

All modifications to pr-agent behavior are concentrated in this package; upstream source stays
untouched. Each patch is wrapped in try/except (see runtime._register_post_import): if it can't be
applied it silently degrades, never letting a shim exception block the flow.
"""
from .patches.describe_assessment import patch as _patch_describe_assessment
from .patches.litellm_handler import patch as _patch_litellm_handler
from .patches.load_yaml import patch as _patch_load_yaml
from .patches.local_git_provider import patch as _patch_local_git_provider
from .runtime import _debug, _register_post_import


def apply() -> None:
    # local_git_provider two patches merged into one patch_fn (registering multiple finders for the
    # same module shadows each other; only the meta_path[0] one takes effect): binary-safe
    # get_diff_files + get_line_link anchor.
    _register_post_import(
        "pr_agent.git_providers.local_git_provider",
        _patch_local_git_provider,
    )
    # litellm handler: CLI mode dispatch + Anthropic temperature removal + wrap _get_completion to collect token usage.
    _register_post_import(
        "pr_agent.algo.ai_handlers.litellm_ai_handler",
        _patch_litellm_handler,
    )
    # load_yaml hardening: on parse failure, strip anchor marker / rearrange multi-line block scalars and retry, to avoid review crashing.
    _register_post_import(
        "pr_agent.algo.utils",
        _patch_load_yaml,
    )
    # /describe approach suggestion: inject an assessment field into the describe prompt, producing an "alternatives + opinionated recommendation" section.
    _register_post_import(
        "pr_agent.tools.pr_description",
        _patch_describe_assessment,
    )
    _debug("meebox shim loaded")
