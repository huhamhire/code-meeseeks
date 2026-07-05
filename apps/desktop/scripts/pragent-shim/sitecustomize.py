# meebox embedded runtime monkeypatch shim -- thin loader.
#
# CPython auto-imports this module via `site` on startup (named sitecustomize, no PYTHONPATH/mount needed).
# The actual patch implementations are split by domain into the `meebox_pragent_shim` package in the same directory (patches/ and cli/).
# This file is only responsible for: calling apply() to register all lazy post-import hooks, and providing an overall fallback -- the shim
# must never crash the interpreter/agent. **Never eager import pr_agent here** (this file runs on every python startup:
# probing --version / find_spec / pip install, etc.; an eager import would slow it down or even error when pr-agent isn't installed yet).
#
# assemble-pragent-runtime.mjs copies this file + meebox_pragent_shim/ wholesale into site-packages.
# See docs/arch/02-agent/05-pragent-runtime.md for details.
try:
    from meebox_pragent_shim import apply

    apply()
except Exception as exc:  # noqa: BLE001 - the shim must never crash the interpreter/agent
    try:
        import os
        import sys

        if os.environ.get("MEEBOX_SHIM_DEBUG"):
            print(f"[meebox] sitecustomize loader error (ignored): {exc}", file=sys.stderr)
    except Exception:  # noqa: BLE001
        pass
