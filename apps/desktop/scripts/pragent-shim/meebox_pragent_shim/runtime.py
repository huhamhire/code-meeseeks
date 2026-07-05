"""Infrastructure for the embedded runtime monkeypatch: lazy post-import hook registration, version guard, logging.

Never eager import pr_agent in this module (or its load chain) -- sitecustomize loads this package on every
python startup, so an eager import would slow every call, or even error when pr-agent isn't installed yet. Each patch's
import of pr_agent always sits inside the patch function body (lazily), executing only when the target module is actually imported.
"""
import importlib.abc
import importlib.util
import os
import sys

# This shim's monkeypatch depends on **a specific version** of pr-agent's internals (get_line_link render
# branch, get_diff_files decode logic, load_yaml, etc.). Upgrading pr-agent may make a patch mismatch or even
# misfire, so it only takes effect for the version pinned below; on version mismatch the relevant patch is
# skipped (safe degradation, preferring to apply fewer patches over applying wrong ones).
# When upgrading pr-agent: sync this constant + prAgent.version in scripts/pragent-runtime.json
# (the assemble script verifies the two match and extracts this constant from this file), and re-verify patch behavior.
_EXPECTED_PRAGENT_VERSION = "0.36.0"

# System context "cache break" marker: assembleSystemContext (TS, packages/agent/src/assemble.ts) inserts this string
# (along with the --- separators on both sides) between the **globally stable prefix** (SOUL/AGENTS/tool directory/memory/user
# profile) and the **PR/run-related tail**. Based on it, the shim marks the stable prefix alone with Anthropic prompt caching (1h),
# keeping the tail as plain text; after the consumers (litellm chunking / CLI concatenation) split or strip it, the marker **never**
# enters the prompt sent to the model. The two constants must match verbatim.
CACHE_BREAK = "\n\n---\n\n[[MEEBOX:CACHE_BREAK]]\n\n---\n\n"


def split_cache_break(system):
    """Split system by cache break → (stable_prefix, variable_tail). Returns (None, system) if no break."""
    stable, sep, variable = system.partition(CACHE_BREAK)
    if not sep:
        return None, system
    return stable, variable


def strip_cache_break(system):
    """Strip the cache break marker (for non-chunking consumers, e.g. CLI prompt concatenation), collapsing into a single --- separator."""
    return system.replace(CACHE_BREAK, "\n\n---\n\n")


def _debug(msg) -> None:
    if os.environ.get("MEEBOX_SHIM_DEBUG"):
        print(f"[meebox] {msg}", file=sys.stderr)


def _warn(msg) -> None:
    """Always writes to stderr (not gated by MEEBOX_SHIM_DEBUG). Used for degradation scenarios where "a patch
    silently fails", such as version mismatch, which must be visible to the user/logs. stderr doesn't affect parse-output (it only parses stdout)."""
    print(f"[meebox] WARNING: {msg}", file=sys.stderr)


def _pragent_version():
    """Read the installed pr-agent version (only reads dist metadata, doesn't import pr_agent). Returns None if unavailable."""
    try:
        from importlib.metadata import version

        return version("pr-agent")
    except Exception:  # noqa: BLE001 - not installed / metadata missing (mid pip install, etc.)
        return None


def _register_post_import(module_name, patch_fn) -> None:
    """Register a meta_path finder: run patch_fn(module) immediately after module_name is imported.
    Doesn't import the module here, keeping python startup/probing/pip lightweight."""

    class _Finder(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            if fullname != module_name:
                return None
            # Temporarily remove self, use the default mechanism to get the real spec, then wrap a loader to patch after exec
            sys.meta_path.remove(self)
            try:
                spec = importlib.util.find_spec(fullname)
            finally:
                sys.meta_path.insert(0, self)
            if spec is None or spec.loader is None:
                return None
            orig_exec = spec.loader.exec_module

            def exec_module(module):
                orig_exec(module)
                try:
                    patch_fn(module)
                    _debug(f"patched {module_name}")
                except Exception as exc:  # noqa: BLE001
                    _debug(f"patch {module_name} failed (ignored): {exc}")

            spec.loader.exec_module = exec_module
            return spec

    sys.meta_path.insert(0, _Finder())
