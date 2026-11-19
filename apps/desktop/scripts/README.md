# Embedded pr-agent runtime

Assemble relocatable CPython and pinned pr-agent into `apps/desktop/vendor/pragent/`, so users do not need Python or Docker. See the [runtime architecture](../../../docs/arch/02-agent/05-pragent-runtime.md).

## Usage

Run from the repository root:

```bash
npm --prefix apps/desktop run prepare:pragent
npm --prefix apps/desktop run prepare:pragent -- --force
```

The first command is idempotent: a matching runtime is reused, but the shim is always synchronized and smoke tests run. `--force` rebuilds the interpreter and dependencies. Packaging targets also prepare the runtime through Nx dependencies.

## Output

```text
apps/desktop/vendor/pragent/          # generated, gitignored
├── python/                          # python-build-standalone, including pip and stdlib
│   └── .../site-packages/
│       ├── pr_agent/
│       ├── sitecustomize.py         # lazy shim loader
│       └── meebox_pragent_shim/
└── VERSION                          # assembly fingerprint and archive SHA-256
```

## Versions and dependencies

- [pragent-runtime.json](pragent-runtime.json) pins Python's release and pr-agent's version. Keep the latter aligned with `_EXPECTED_PRAGENT_VERSION` in `pragent-shim/meebox_pragent_shim/runtime.py`; assembly rejects a mismatch.
- The assembly script resolves the host's `install_only` Python archive from its GitHub release and verifies the published SHA-256 sidecar when available.
- Install the core `pr-agent` distribution. Since 0.48, hosted git-provider SDKs are optional extras; the app uses the local provider and handles platform access through its own adapters. Do not delete SDK dependencies by name: LiteLLM may require them independently.
- Node 22+ and network access are required for the initial build. Archive extraction uses `tar` from npm. An optional `GITHUB_TOKEN` avoids unauthenticated GitHub API rate limits.
- Assembly supports Windows x64, macOS arm64/x64, and Linux x64 hosts. This does not imply that every platform has a release installer.

## Verification

`prepare:pragent` checks lazy shim loading, patch activation, standard-library extensions, a mocked LiteLLM completion, and bundled tokenizer hashes. `tiktoken-cache.py` locates the bundled cache explicitly because newer LiteLLM versions initialize it lazily. It primes encodings during assembly and verifies offline loading after slimming; runtime execution must not repair files under the installation directory.

`tests/test_pragent_runtime.py` exercises the installed version, empty fallback configuration, trusted base-branch context, dirty worktrees, file anchors, description assessment, YAML repair, API usage/cache/temperature handling, CLI dispatch, and local output from describe/review/ask/improve. Model responses are synthetic; no real model or remote code platform is called.

The source-only CLI argument tests can also run independently:

```bash
# Windows; use vendor/pragent/python/bin/python3 on macOS/Linux
apps/desktop/vendor/pragent/python/python.exe -B -S apps/desktop/scripts/tests/test_cli_args.py
```
