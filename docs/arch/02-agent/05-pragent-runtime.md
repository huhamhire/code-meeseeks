# pr-agent integration & runtime

## Responsibilities & boundaries

Bring the third-party pr-agent (Python) in to run `/describe` `/review` `/ask`, and solve "where the runtime comes from, how to change its behavior non-invasively, how to get real token usage".

Owns: the invocation bridge (multi-strategy), the embedded Python runtime packaged with the app, the monkeypatch patch system over pr-agent,
token-usage collection, env injection. Does not own: output parsing and drafts (see [Review workflow](../01-platform/03-review-workflow.md)), git/worktree (see [Repo mirror](../01-platform/02-repo-mirror.md)).

## Core design

### Invocation bridge (strategy pattern)

`PrAgentBridge` has two strategies, auto-selected by startup probe, forcible on the settings page:

- **embedded (default)**: run `python -m pr_agent.cli` with the embedded interpreter packaged with the app, so the user installs nothing.
- **local-cli**: use the system `pr-agent` CLI (advanced users self-manage Python).

> The Docker strategy has been removed: container filesystem mounting is inefficient and inconsistent with the "zero dependencies" positioning; the embedded local process already covers all scenarios.

It uniformly runs in **LocalGitProvider mode** on a materialized worktree (`CONFIG__GIT_PROVIDER=local`, cwd=worktree).
Note the counterintuitive point of pr-agent community-edition's LocalGitProvider: the `--pr_url` slot is filled with the **target branch name** (not a URL),
and the repo root is located via the `.git` parent directory of the cwd. Output does not go to stdout — pr-agent **writes results to markdown files at the worktree root**
(`/describe`→`description.md`, `/review` `/ask`→`review.md`), and the wrap-up reads from the file, with stdout kept only as a log.

Upgrading pr-agent ≈ changing the version number, with zero impact on the main code (this is the fundamental reason for choosing an "external process" over a "TS rewrite").

### Embedded runtime

Packaged with the app is a **relocatable CPython** (python-build-standalone's install_only build) + a build-time isolated install of a
**pinned version of pr-agent**. The assembly script, per a manifest (pinned python version + pr-agent version), downloads the interpreter,
`pip install pr-agent==<ver>`, injects the shim, and does an `import pr_agent` smoke test. The runtime lands outside the asar as `extraResources`
(the native interpreter + `.so/.pyd` must be real files). It is assembled by the build machine's host platform, matching the target platform.

### monkeypatch shim (change pr-agent non-invasively)

Manages centrally **all** behavior modifications to pr-agent, keeping the upstream source untouched. The source is in `apps/desktop/scripts/pragent-shim/`:
a thin loader `sitecustomize.py` (auto-imported by `site` at CPython startup, no mounting / `PYTHONPATH` needed) + the domain-split
`meebox_pragent_shim/` package:

```
meebox_pragent_shim/
├── __init__.py        # apply(): register all lazy post-import hooks
├── runtime.py         # finder registration · version guard _EXPECTED_PRAGENT_VERSION · logging
├── usage.py           # @@MEEBOX_USAGE@@ token sentinel
├── patches/           # patch(module) for each pr_agent module: local_git_provider · litellm_handler · load_yaml
└── cli/               # local CLI provider: parsers · specs(_CLI_SPECS) · install
```

Design principles:

- **Lazy post-import hook**: register a meta_path finder that patches only when the target module is **actually imported** (= a real run);
  never eager-import pr_agent at the sitecustomize stage (which would slow down every startup/probe/pip). Each patch module's import of `pr_agent`
  is inside the patch function body; the top level only imports the same package's runtime/usage — so importing this package doesn't trigger pr_agent loading.
- **Multiple patches of the same module merge into one patch_fn**: registering multiple finders for the same module shadow each other, and only the frontmost takes effect.
- **Version guard**: patches depend on a specific pr-agent version's internal implementation → if `_EXPECTED_PRAGENT_VERSION` ≠ the actually installed version at runtime,
  **skip all patches and emit a stderr WARNING** (safe degradation); at build time it hard-checks the shim constant == the manifest version, failing outright on mismatch.

Current patches:
- **Binary-safe diff**: the original `get_diff_files` blindly utf-8-decodes every file and crashes on binary → changed to skip on decode failure.
- **anchor line numbers** (details in [Review workflow](../01-platform/03-review-workflow.md)): patch `get_line_link` to return `meebox:///<file>#L<s>-L<e>`,
  letting `/review`'s key_issues render with a structured file:line.
- **Anthropic drops temperature**: new Claude models deprecate temperature, so all `anthropic/*` are put into the "don't send temperature" set.
- **load_yaml tolerance**: an anchor marker taking a whole line breaks YAML → on parse failure, strip the marker and retry, avoiding a whole review crash.
- **repo-context file fetch**: pr-agent 0.39.0 defaults `repo_context_files = ["AGENTS.md"]`, but `LocalGitProvider` inherits the base no-op `get_repo_file_content` → the feature is skipped with a per-run WARNING. Implement it by reading the blob from the base branch's tree (`git show <target_branch>:<path>`, never the working tree), so `/review /describe /improve` inject the reviewed repo's `AGENTS.md`/etc. as `<instruction_files>`; a missing file degrades to `""`.
- **Local CLI provider**: when `MEEBOX_CLI_MODE` is set, replace `chat_completion` wholesale with the "call the local CLI" version (see below).
- **token usage collection**: see below.

### Real token usage

Inline-wrap pr-agent's `_get_completion`, take `prompt/completion/total_tokens` from the returned `response.usage`,
and print it to **stderr** as the sentinel line `@@MEEBOX_USAGE@@ {json}`; the main process captures line by line, accumulates by prefix, and lands it on the run (see [Review workflow](../01-platform/03-review-workflow.md)).
**Why inline rather than a litellm callback**: litellm's async callback goes through a background logging worker, and a short-lived CLI exiting too fast gets it dropped;
inline within the await chain must execute before exit, so it's reliable. Only tokens are taken, not cost → uniformly set `LITELLM_LOCAL_MODEL_COST_MAP=True`
to turn off litellm's remote price-table networking (a weak network causes SSL timeout). Also set `litellm.suppress_debug_info=True` at patch time: the orchestration chat
channel uses the subprocess **stdout** as the model reply, and for a new model not in the local `model_cost` table (e.g. `claude-opus-4-8`), litellm, on failing to call
`get_llm_provider` in cost/token metering, first `print`s a decorative "Provider List: …" (ANSI red text) before raising (the error is swallowed and doesn't affect the result),
and that print would pollute stdout and leak into the review summary — this switch turns those prints off.

### Local CLI provider

Let the user run reviews **without filling in an API key, using a locally installed and logged-in agentic CLI** (phase one is **Claude Code** only). The LLM Profile
gains `provider='cli'`, with the `model` field holding the command name (`claude`). Other providers go through litellm direct-to-API, while cli mode **fully bypasses
litellm**.

- **Entry point**: env `MEEBOX_CLI_MODE=1` + `MEEBOX_CLI_BIN=claude` (injected by `buildPragentEnv`) → the shim swaps
  `LiteLLMAIHandler.chat_completion` wholesale for the version that "spawns a `claude -p --output-format json` subprocess, feeds the prompt via stdin,
  parses the JSON `result` text + `usage`", returning `(text, "stop")`. It **depends only on the stable contract of `base_ai_handler`,
  free of the version guard** (unlike the other patches that depend on internal implementation, it goes before the version guard). The subprocess-invocation logic is factored into `run_cli_chat` in
  `cli/install.py`, shared by `_install_cli_chat_completion` (serving pr-agent tool runs) and the orchestration chat channel.
- **Orchestration chat channel CLI shortcut**: the previous item serves the **pr-agent tool run** (`/describe` `/review` `/ask` via `pr_agent.cli`,
  which must pass `chat_completion`). The **orchestration's own steps** (routing / judge / summary via `meebox_pragent_shim.chat`) in CLI mode
  **call `run_cli_chat` directly, without importing pr_agent / litellm** — the CLI path doesn't use litellm anyway, and needlessly spinning up the whole pr_agent +
  litellm import would add hundreds of ms to 1s+ of startup overhead per chat subprocess, while orchestration calls many times per flow. API mode has no such shortcut (litellm
  is the HTTP client, unbypassable), still reusing the patched `LiteLLMAIHandler` to inherit provider routing / temperature-drop / prompt cache /
  usage sentinel.
- **Prompt via stdin**: the review prompt contains the full diff (tens of KB), and passing via argv would hit the command-line length limit; system/user are merged into
  one block to feed in (the CLI has no separate system slot). cwd defaults to a neutral temp directory, avoiding picking up the reviewed repo's `CLAUDE.md`/`AGENTS.md`.
- **`/ask` exception (take full file context)**: free Q&A needs to read real files, so only for `/ask` the main process hands down env `MEEBOX_CLI_WORKDIR`
  = the materialized worktree, and the shim accordingly sets the subprocess cwd to the worktree (`describe`/`review` don't get it, keeping the neutral temp directory).
  Before setting cwd, the main process first **clears the repo's own agent instruction files inside that worktree** (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`.cursor`
  rules / `.github/copilot-instructions.md`, see `services/pr-agent/worktree-sanitize.ts`) — the worktree is the PR HEAD,
  author-controlled, and if not cleared the CLI would auto-load these instructions, letting the reviewed PR inject / pollute the answer through them; the worktree is discarded after use, so clearing in place has no side effect.
- **Reuse the CLI's own login state**: the subprocess inherits `HOME`/`USERPROFILE`, and the CLI reads its own login credentials (e.g. `~/.claude`) to run.
  To avoid a stray API key in the local environment leaking in and overriding the CLI's own login method, the shim explicitly strips
  `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from the subprocess env. The model used, the quota and compliance are all decided by that CLI's account and the user's authorization.
- **Proxy auto pass-through**: the subprocess env is copied from `os.environ` (only the two API keys above removed), and `HTTP(S)_PROXY` / `NO_PROXY`
  are kept as-is → `claude`'s egress automatically goes through the user-configured proxy (see [Networking & proxy](../99-core/03-networking-proxy.md)), no extra setup needed.
- **token usage**: from the claude JSON's `usage`, construct the same `@@MEEBOX_USAGE@@` sentinel, accumulated by the same main-process path. The ↑ total input takes
  `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` (the entire input side the model actually processed); of which
  `cache_read_input_tokens` (the cache read) is **listed out separately** for UI split display, and the top-level `num_turns` (agentic turns) is thrown up alongside. Details in
  "Token metering & prompt cache in CLI mode" below.
- **Phase-one boundary**: `claude` only (UI validation blocks codex, etc.; the command box accepts input pending later work); concurrency is "one subprocess per call"; when the parent process is
  SIGKILLed on timeout, the child `claude` may briefly linger (orphan), and kill propagation can be added later.

### Token metering & prompt cache in CLI mode

In CLI (claude / codex) mode a run card's token count is often far beyond the model's single-request context window (e.g. `/ask` showing ↑ millions); this is **not over-limit, nor a metering
error**, but the natural result of agentic multi-turn + prompt caching. Key points:

- **Accumulative semantics**: `claude -p` is agentic headless, and one run internally has multiple model turns (`num_turns`). The top-level `usage` is **the accumulation across all turns
  of that session**; each turn re-feeds the ever-growing conversation / tool results into the model, so tokens stack with the turns. A single turn never exceeds the window (the CLI itself does context compression), and the accumulated value
  bloating is normal. The UI shows the turns per `num_turns` (not shown for a single turn), helping the reader understand "this is the total across N turns, not a single-request scale".
- **`cache_read` vs `cache_creation` (a read hit ≠ a write)**: Anthropic prompt caching splits input into three parts — `input_tokens` (new content),
  `cache_creation_input_tokens` (**written** to cache, billed 1.25×/2×), `cache_read_input_tokens` (**read hit**, billed 0.1×). The UI's
  "cache read (⛁)" **takes only `cache_read`**; a write does not count as a hit. In multi-turn, every turn re-reads the cached prefix, and `cache_read` accumulates across turns, so a multi-turn run often
  shows "cache read ≈ total input" (the vast majority of input is cache reads). **codex follows the OpenAI convention**: `input_tokens` itself **already includes** cache, and the hit field name is
  `cached_input_tokens`, so the collection layer (`cli/install.py`) recognizes both field names — Anthropic's `cache_read_input_tokens` must be accumulated into the total, while
  codex's `cached_input_tokens` counts only as the hit and is not added to the total again.
- **Cache warming & task order**: the claude CLI itself server-side-caches the same prefix within the cache TTL (5min / 1h) (the base system prompt, tool definitions, even the same
  diff segment). **Running `describe` first warms the cache**, and a subsequent `review` on the same PR is mostly `cache_read` hits, with very little truly new input → showing "very
  little input, almost all cache reads". This is a normal optimization from sequential execution, not a statistical anomaly.
- **Effect of parallel startup on cache hits**: the run queue (`pump()` in `services/pr-agent/run-queue.ts`) starts synchronously and continuously when concurrency is below the cap, so the same PR's
  describe / review / improve start almost simultaneously (~100ms apart). An Anthropic cache entry can only be read by later requests after the **first request finishes writing**, and at parallel startup a later
  request can't read the not-yet-landed cache → the shared prefix each misses + each writes, and the hit rate drops. But **the impact is limited**: only the small cross-run shared prefix is affected (the base system
  ~20–30k, usually already warmed by other claude activity), while the large `cache_read` comes from **the multi-turn re-reads within a single run**, unrelated to parallelism. So it is generally **not worth**
  serializing same-PR tasks for cache reuse; if you really want to maximize cross-run reuse, consider lightweight scheduling of "describe first, release the rest after it finishes" (limited gain, not implemented).
- **litellm path & cross-model cache adaptation**: in API mode the explicit `cache_control` marker **takes effect only on the Anthropic family** (native / Bedrock / Vertex Claude).
  `_apply_system_prompt_cache` (`patches/litellm_handler.py`) marks a 1h-TTL cache for Anthropic, covering two kinds of calls:
    - **Orchestration chat channel** (`MEEBOX_CHAT_CACHE` set, system contains `CACHE_BREAK`) caches the globally stable prefix by breakpoint;
    - **pr-agent tool run** (`/review` `/describe` `/improve` `/ask`, no `CACHE_BREAK`) caches the whole system — pr-agent's instructions + output format are about 12k chars, vary only by config/language/rules, and are stable across PRs (the variable diff is on the user side and not cached), so under the same config it hits across runs within 1h.

  OpenAI / DeepSeek use **automatic prefix caching** (no marking needed; put stable content in the prefix
  to hit; the shim auto-strips the markers for non-Anthropic and reassembles plain text); whether openai-compatible (DashScope / Volcano / vLLM) hits depends on the backend,
  and `cache_control` is always ignored. Both paths (CLI / API) collect `cache_read` (API takes Anthropic's `cache_read_input_tokens` or OpenAI's
  `prompt_tokens_details.cached_tokens`), and the UI display is consistent.

### Env injection

Each run injects into the subprocess: LLM provider credentials (`OPENAI__KEY` / `DEEPSEEK__KEY` / `ANTHROPIC__KEY`, etc., grouped by provider family;
cli mode sends no secret, only the two sentinels `MEEBOX_CLI_MODE` / `MEEBOX_CLI_BIN`) +
model name + response language + the matched rules' `EXTRA_INSTRUCTIONS` (see [Rules](04-rules.md)) + the outbound proxy (see [Networking & proxy](../99-core/03-networking-proxy.md)).

## Data / interface contract

- **Strategy**: `'auto' | 'embedded' | 'local-cli'` (config `pr_agent.strategy`).
- **Run options**: `prUrl` / `tool('describe'|'review'|'ask')` / `cwd`(worktree) / `targetBranch` / `env` / `extraArgs` /
  `onLine`(stdout/stderr real-time callback) / `signal`(cancellation).
- **Runtime manifest**: pinned python major.minor version + pr-agent version (synced with the shim's `_EXPECTED_PRAGENT_VERSION` on upgrade).
- **shim debugging**: `MEEBOX_SHIM_DEBUG=1` → the shim prints stderr diagnostics.

## Extension & caveats

- **Upgrading pr-agent**: change the manifest version → sync the shim's `_EXPECTED_PRAGENT_VERSION` → re-verify each patch (the build time hard-checks
  the two are consistent, failing outright if a sync is missed; at runtime a mismatch degrades + WARNING).
- **Changed the shim**: run `prepare:pragent` once to re-sync into vendor (the idempotent skip branch also syncs the shim), no `--force` full rebuild needed.
- **Streaming models drop usage**: a few models that must force streaming use MockResponse and have no usage, so token collection is missing for them (non-streaming is unaffected).
- **Startup overhead**: no obvious bottleneck currently under the embedded local process. If a large PR reproduces the issue, pr-agent's internal preprocessing can be trimmed (env switch).
- **Platform scope**: the embedded runtime's first release ships only Windows x64 + macOS arm64 (see [Packaging & release](../../development/packaging-release.md)).
