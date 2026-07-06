# Config File Reference

**English** · [简体中文](zh-CN/04-config-reference.md)

All configuration lives in a single config file, **`~/.code-meeseeks/config.yaml`** (YAML format). For day-to-day use, visual editing via the in-app **Settings** page and the first-launch wizard is enough — no need to edit the file by hand; this document is the complete structure and field reference, for bulk configuration, advanced parameter tuning, and troubleshooting.

- **How to edit**: saving on the Settings page writes to disk and hot-reloads; the Settings page's "Open config.yaml with the system default app" lets you edit the file directly.
- **When it takes effect**: connection / LLM / proxy / language / concurrency, etc. are rebuilt and applied immediately on save; a few advanced parameters (such as `workspace.repos_dir`) require an app restart.
- **A note on credentials**: access tokens, API keys, and proxy passwords are stored in **plaintext** in this file (isolated from the config structure but not encrypted). Request credentials with least privilege, protect this file well, and revoke promptly on leak.

## Full example

```yaml
language: ''            # empty = auto by system language, falling back to English; or explicitly zh-CN / en-US / ja-JP / de-DE

appearance:
  editor_theme: auto
  editor_font_family: ''
  editor_font_size: 14

workspace:
  repos_dir: ~/.code-meeseeks/repos

agent:
  dir: ''
  max_steps: 8
  summary_max_chars: 800
  autopilot:
    enabled: false
    batch_size: 10
    grants: []
  strategy:
    auto_followup: true
    max_followup_asks: 2
    max_code_suggestions: 4
    code_suggestion_spec: ''
    code_suggestion_layout: ''

poller:
  interval_seconds: 300

proxy:
  enabled: false
  protocol: http
  host: ''
  port: 8080
  username: ''
  password: ''

pr_agent:
  strategy: auto
  max_concurrency: 2

notifications:
  enabled: true
  new_pr: true
  reply: true
  mention: true
  authored_comment: true
  authored_needs_work: true
  authored_conflict: true

service:
  enabled: false
  host: 127.0.0.1
  port: 18765
  token: ''

update:
  check_enabled: true

connections:
  - id: my-bitbucket
    kind: bitbucket-server
    base_url: https://bitbucket.example.com
    display_name: Company Bitbucket
    auth:
      type: pat
      token: <BITBUCKET_HTTP_ACCESS_TOKEN>
    clone:
      protocol: pat
  - id: my-github
    kind: github
    base_url: https://api.github.com
    display_name: GitHub
    auth:
      type: pat
      token: <GITHUB_PERSONAL_ACCESS_TOKEN>
    clone:
      protocol: pat

active_connection_id: my-bitbucket

llm:
  active_id: default
  context_tokens: 128000
  profiles:
    - id: default
      label: OpenAI
      provider: openai
      base_url: ''
      model: gpt-4o
      api_key: <OPENAI_API_KEY>
```

## Top-level fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `language` | string | `''` (auto) | Language used by the UI and pr-agent-generated content (ISO locale, e.g. `zh-CN` / `en-US` / `ja-JP` / `de-DE`). **Default empty = auto**: matched against your system's preferred language, falling back to English if none fits. Switchable on the Settings page (hot-applied). |
| `appearance` | object | — | UI and editor appearance (theme / font), see below. |
| `workspace` | object | — | Working directory settings, see below. |
| `agent` | object | — | Advanced Agent and AutoPilot settings (the Agent directory and personalized rules both belong here), see below. |
| `poller` | object | — | PR polling settings, see below. |
| `proxy` | object | — | Outbound network proxy settings, see below (details in [Network proxy setup](03-proxy.md)). |
| `pr_agent` | object | — | pr-agent runtime settings, see below. |
| `notifications` | object | — | System notification and dock badge settings, see below. |
| `service` | object | — | Local API service (CLI / external integration entry) settings, see below (details in [CLI tool](06-cli.md)). |
| `update` | object | — | Version update-check settings, see below. |
| `connections` | array | `[]` | Code platform connection list, see below (details in [Code platform setup](01-code-platform.md)). |
| `active_connection_id` | string | `''` | The `id` of the currently active connection, see below. |
| `llm` | object | — | LLM profile settings, see below (details in [LLM setup](02-llm.md)). |

## `appearance` — appearance

Purely front-end display items for the UI and editor (the main process only sets the native window's light/dark from the theme). All are visually adjustable on the Settings page and take effect immediately.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `editor_theme` | enum | `auto` | Global theme (shared by the Monaco editor and the whole UI): `auto` follows the system dark / light, the rest are built-in / third-party theme ids. |
| `editor_font_family` | string | `''` | The editor's monospace font family (CSS font-family, comma-separated candidates allowed). Empty = the built-in mono font stack. |
| `editor_font_size` | integer | `14` | Editor font size (px), constrained to a reasonable range. |

## `workspace` — working directory

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `repos_dir` | string | `~/.code-meeseeks/repos` | Directory storing the repos' local mirrors (bare clones). Changes fully take effect only after an app restart. Supports `~` expansion. |

## `agent` — Advanced Agent & AutoPilot

The advanced Agent turns natural-language requests into autonomous planning + multi-tool orchestration (design in [docs/arch/02-agent/01-agent.md](../arch/02-agent/01-agent.md)). The **Agent directory** `<agent.dir>/` is the Agent's complete persona and knowledge source, with a fixed layout:

```
<agent.dir>/
├── SOUL.md      # Soul: core responsibilities and boundaries (read-only)
├── AGENTS.md    # Working conventions and red lines
├── MEMORY.md    # Long-term memory (writable)
├── USER.md      # User profile (writable)
└── rules/       # Personalized rules directory (the former rules.dir folded in here; structure in Custom review rules)
```

The Agent **has no separate enable toggle** — it's available once an LLM is configured and pr-agent is ready. When `dir` is empty it falls back to the default location under the working directory, `~/.code-meeseeks/agent` (a startup-time idempotent scaffold fills in any missing files); a custom path can point at a git repo, making it easy for a team to share context and rules.

> **Migrating from the old `rules.*`**: earlier versions configured personalized rules at the top-level `rules.dir`; this is now folded into `<agent.dir>/rules/`, and **the old `rules.*` fields are no longer read**. Just move the contents of your original rules directory into `<agent.dir>/rules/` (the rule file structure is unchanged, see [Custom review rules](05-rules.md)).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `dir` | string | `''` | Agent directory path. Empty = the default `~/.code-meeseeks/agent` under the working directory. Supports `~` expansion. Can point at a git repo to share. |
| `max_steps` | integer | `8` | Upper bound on the Agent's planning steps per session, `1`–`50`. |
| `summary_max_chars` | integer | `800` | Strict length limit (characters) of the closing summary, `100`–`4000`. |
| `autopilot` | object | — | AutoPilot pre-review settings, see below. |
| `strategy` | object | — | Agent behavior strategy (applies to manual auto-review and AutoPilot), see below. |

### `agent.autopilot` — AutoPilot pre-review

After polling discovers PRs awaiting review, automatically pre-runs `/describe` + `/review`, so a draft awaits your confirmation the moment you open the app (the decision still rests with the reviewer). Admission control only lets through "awaiting my review · pending" PRs not yet reviewed; removing / purging a PR terminates an in-flight task.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | AutoPilot master switch. Toggleable in the status bar; when `false` the scheduling logic doesn't run at all. |
| `batch_size` | integer | `10` | Upper bound on PRs per single LLM-judged batch, `1`–`50`. |
| `grants` | array | `[]` | Per-item write-permission grants (default empty = deny all), e.g. `approve` / `needs_work` / `publish_comment`; enforced against the red lines at runtime. |

### `agent.strategy` — Agent behavior strategy

Applies to the auto-review micro-flow (shared by manual "auto review" and AutoPilot), not AutoPilot-exclusive.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `auto_followup` | boolean | `true` | Whether the review stage enables **automatic follow-up** (conditional `/ask`). Disabling it skips the interpretation + follow-up and summarizes directly, saving an LLM call and the follow-up cost. |
| `max_followup_asks` | integer | `2` | Upper bound on automatic follow-ups (a hard cap on conditional `/ask`), `0`–`5`. Effective only when `auto_followup` is on; `0` is equivalent to off. |
| `max_code_suggestions` | integer | `4` | Upper bound on code suggestions generated by a single `/review`, `/improve`, or `/ask`, `2`–`8`. |
| `code_suggestion_spec` | string | `''` | Free-text spec injected into `/improve`, `/review`, `/ask` to shape how each suggestion is written (soft constraint). Empty = nothing injected. See below. |
| `code_suggestion_layout` | string | `''` | Deterministic markdown layout for the review-draft comment created from a suggestion. Empty = the default layout. See below. |

#### Code-suggestion spec & layout

Two optional fields control how AI code suggestions read and how they land in a review-draft comment. Both are editable from **Settings → Agent → Strategy** via an inline editor, so you don't have to hand-edit the config file.

- **`code_suggestion_spec`** — a *soft* guideline appended to the model's instructions for `/improve`, `/review`, and `/ask`. Use it to steer the content structure of each suggestion, e.g. _"Structure every suggestion as three sections — Problem, Analysis, Suggestion — each on its own line."_ The model generally complies but is not guaranteed to.
- **`code_suggestion_layout`** — a *deterministic* markdown template applied when a suggestion becomes a review-draft comment (substitution is exact, no dependency on the model). Placeholders:

| Placeholder | Value |
| --- | --- |
| `<TITLE>` | Localized "AI suggestion" label |
| `<SUGGESTIONS>` | The suggestion body |
| `<HOME>` | Project website |
| `<PR>` | Current PR link |
| `<MODEL>` | Current active model name |

If the layout contains `<SUGGESTIONS>` it is used as the full comment body; otherwise the whole string is prepended as a prefix before the body. Empty falls back to the default layout:

```text
[[<TITLE>](<HOME>) (<MODEL>)]
<SUGGESTIONS>
```

## `poller` — PR polling

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `interval_seconds` | integer | `300` | The interval in seconds for automatically polling PRs awaiting review, minimum `30`. |

## `proxy` — outbound network proxy

When enabled, LLM calls, code platform REST, and git HTTPS all go through the proxy; loopback / local addresses (including a local Ollama) connect directly. git fetch over SSH does not use this config — configure it yourself in `~/.ssh/config`.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Proxy master switch. Off = everything connects directly. |
| `protocol` | enum | `http` | Currently only `http` is supported. |
| `host` | string | `''` | Proxy host address. |
| `port` | integer | `8080` | Proxy port, `1`–`65535`. |
| `username` | string | `''` | Basic Auth username, empty if no auth. |
| `password` | string | `''` | Basic Auth password, empty if no auth. |

## `pr_agent` — runtime

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `strategy` | enum | `auto` | Runtime strategy: `auto` prefers the bundled embedded runtime and falls back to the system `pr-agent` CLI if missing; you can also force `embedded` / `local-cli` explicitly. |
| `max_concurrency` | integer | `2` | Review task concurrency, `1`–`8`. Adjustable in the "AI" section of the Settings page (hot-applied, no restart), or edit this file by hand — details in [LLM setup · Advanced: review concurrency](02-llm.md#advanced-review-concurrency). |

## `notifications` — notifications

Toggles for system notifications (toasts) and the macOS dock "awaiting response" badge. `enabled` is the master switch (when off, neither notifications pop nor the badge lights up); the rest control system notifications per event type — `new_pr` / `reply` / `mention` target scenarios like "awaiting my review", and `authored_*` target "authored by me" PRs. System notifications are subject to OS permissions, and the app silently degrades if the user disables them in system settings. Adjustable on the Settings page, effective immediately.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Notification master switch; when off, no system notifications pop and the dock badge doesn't light up. |
| `new_pr` | boolean | `true` | Pop a notification when a new PR awaiting my review appears. |
| `reply` | boolean | `true` | Pop a notification when a comment reply is received. |
| `mention` | boolean | `true` | Pop a notification when @-mentioned in a comment. |
| `authored_comment` | boolean | `true` | Pop a notification when a PR I authored receives a new comment from someone else. |
| `authored_needs_work` | boolean | `true` | Pop a notification when a PR I authored is marked "needs work" in review. |
| `authored_conflict` | boolean | `true` | Pop a notification when a PR I authored develops a merge conflict. |

## `service` — local API service

Listen configuration for the local HTTP API service, providing app capabilities to the `meebox` CLI and external scripts / agents (details in [CLI tool](06-cli.md)). Off by default with zero exposure; enabling it **enforces** bearer token auth. Visually toggle and view / copy / regenerate the token in the "Integration" section of the Settings page, effective immediately (a toggle / host / port change stops the old and starts the new; a token change takes effect on the next request).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Service master switch. Off = not listening, no exposure. |
| `host` | string | `127.0.0.1` | Listen address. Default reachable only from the local machine; set `0.0.0.0` to expose to the LAN (high risk — the token is the only line of defense then). |
| `port` | integer | `18765` | Listen port, `1`–`65535`. |
| `token` | string | `''` | Access token (bearer). Auto-generated on first enable; regeneratable on the Settings page (the old token is invalidated immediately). Stored in plaintext. |

## `update` — version update check

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `check_enabled` | boolean | `true` | On startup (and on manual trigger from the Settings page), check the latest stable version on GitHub Releases and compare it against the current version; if newer, only **prompt** you to go download it (no auto-download / install). Set to `false` to disable the check — this toggle is adjustable only by editing this file (the Settings page shows update status but offers no toggle). |

## `connections` — code platform connections

`connections` is an array, each element being one connection. `kind` determines the platform type and field shape.

### Common fields

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Connection unique identifier, referenced by `active_connection_id`. |
| `kind` | enum | Platform type: `github` / `bitbucket-server` / `gitlab`. |
| `display_name` | string | Display name (shown on the Settings page and status bar). |
| `auth.type` | literal | Fixed `pat`. |
| `auth.token` | string | Access token (PAT). For required permissions see [Code platform setup](01-code-platform.md). |
| `clone.protocol` | enum | git clone protocol: `pat` (default, HTTPS, username + PAT embedded in the URL) / `ssh` (uses the system `~/.ssh/config`). |

### `kind: github`

| Field | Type | Description |
| --- | --- | --- |
| `base_url` | string (URL) | GitHub API base. **Optional**: empty defaults to `https://api.github.com` (github.com); for GitHub Enterprise Server enter the instance address `https://<ghe-host>`, and `/api/v3` is appended automatically (a full API base by hand also works). The clone / web domains are derived by the app automatically. |

### `kind: bitbucket-server`

| Field | Type | Description |
| --- | --- | --- |
| `base_url` | string (URL) | Bitbucket Server / Data Center address, e.g. `https://bitbucket.example.com`. **Required**. |

### `kind: gitlab`

| Field | Type | Description |
| --- | --- | --- |
| `base_url` | string (URL) | GitLab API base. **Optional**: empty defaults to `https://gitlab.com/api/v4` (gitlab.com); for Self-Managed enter the instance address `https://<gitlab-host>`, and `/api/v4` is appended automatically (a full API base by hand also works). The clone / web domains are derived by the app automatically. |

## `active_connection_id` — currently active connection

| Type | Default | Description |
| --- | --- | --- |
| string | `''` | Takes the `id` of one connection. Only one is active at a time: only it is polled, and the PR list and status bar reflect only it. An empty string / an id that doesn't exist polls no connection (the UI guides you to enable one). `connections` still retains all configuration, and historical PRs are unaffected. |

## `llm` — LLM profiles

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `profiles` | array | `[]` | LLM profile list, each with independent provider / model / base_url / api_key. |
| `active_id` | string | `''` | The `id` of the profile currently in effect. An empty string / an id that doesn't exist injects no LLM environment variables into the review (pr-agent falls back to reading shell environment variables). |
| `context_tokens` | integer | `128000` | Context-length limit (tokens) for trimming input content, `32000`–`1000000`. Over-long changes are truncated to this to fit the model. **Does not apply to local CLI mode** (the CLI tool manages its own context). Adjustable in the "AI" section of the Settings page (effective on the next review). |

### A single profile (`profiles[]`)

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | string | — | Profile unique identifier, referenced by `active_id`. |
| `label` | string | `''` | Display name; when empty the UI falls back to provider + model. |
| `provider` | enum | `openai-compatible` | Provider: `openai` / `anthropic` / `deepseek` / `dashscope` (Alibaba Bailian) / `volcengine-ark` (Volcengine Ark) / `openai-compatible` (any OpenAI-protocol-compatible service, including a local Ollama's `/v1`) / `cli` (a local agentic CLI, no direct API connection). The old value `ollama` is auto-migrated to `openai-compatible`. |
| `base_url` | string | `''` | API endpoint. Most official providers leave it empty for the default; `openai-compatible` / self-hosted must fill it in. |
| `model` | string | `''` | Model name. Most providers take only the model name and the app adds the litellm prefix automatically; in `cli` mode this holds a command name (e.g. `claude`). |
| `api_key` | string | `''` | Auth key. Empty for local types (local CLI / self-hosted service without auth). |

For value examples per provider and local CLI mode notes, see [LLM setup](02-llm.md).
