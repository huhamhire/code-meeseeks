# Config & secrets

## Responsibilities & boundaries

Uniformly manage application config and sensitive credentials: a single `config.yaml` (connections, LLM, rules, polling, proxy, etc.) + a credential abstraction + a visual editor on the settings page + a setup wizard.

In scope: config schema, read/write and hot-reload, the credential store/retrieve abstraction, the settings UI. Out of scope: how each subsystem uses this config (see the respective doc).

## Core design

- **A single `config.yaml` (including sensitive fields)**: config and credentials are merged into one file rather than splitting out a `secrets.yaml` (less mental overhead). File permissions are tightened (Unix 600 / Windows ACL). **The application data directory is fixed** at `~/.code-meeseeks/` (config/state/logs/); only `workspace.repos_dir` is changeable (see [State storage](01-state-storage.md)).
- **Schema defined with zod + full-field defaults**: on parse, missing fields are filled with defaults, so old configs stay auto-compatible and new fields are non-breaking. The top-level shape is shown in the `config.yaml` example under "Data / interface contract" below.
- **Credential abstraction `SecretStore`**: all token / API key reads/writes go through it, never `fs` directly. Phase one implements storing credentials in `config.yaml` (`ConfigFileSecretStore`); a keytar/OS Keychain implementation is reserved so that later only the injection is swapped, with zero business change. Credentials **never enter logs / exception stacks**.
- **Multiple LLM profiles**: `llm.profiles[]`, each with its own `provider / model / base_url / api_key`, with `active_id` selecting the active one. The built-in provider options (openai / openai-compatible / deepseek / anthropic / dashscope / volcengine-ark / cli); the provider decides which family of env is injected (see [pr-agent runtime](../02-agent/05-pragent-runtime.md)). A local Ollama connects via openai-compatible's `/v1` endpoint (the old `ollama` value is auto-migrated).
- **Hot-reload (write to disk + in-memory sync)**: on saving each setting, write `config.yaml` **and** update the in-memory config, hot-rebuilding the affected runtime when necessary (e.g. a connection/proxy change rebuilds the adapter, a polling-interval change hot-swaps the timer), without restart.
- **Visual CRUD on the settings page**: connections, LLM profiles, proxy, the rules directory, polling interval, and `repos_dir` can all be edited on the settings page; connections/LLM have a "Test" entry point (ping / proxy connectivity). There is also "Open config.yaml with the system-associated program" for direct editing (suited to advanced users, reducing redundant UI).
- **Setup wizard**: on first launch it auto-creates `~/.code-meeseeks/` + a default `config.yaml`, and guides configuring the code-platform connection (+ optional LLM), the fastest path to a usable state.

## Data / interface contract

The application config is a single `config.yaml`, with this top-level shape (excerpt; missing fields are filled with defaults by zod, old configs are non-breaking compatible):

```yaml
language: ''                     # UI / pr-agent output language; empty = auto by OS, fall back to English
appearance:                      # pure frontend display items (the main process only sets the native window themeSource from the theme)
  editor_theme: auto             # 'auto' follows system light/dark, or a built-in / third-party theme id
connections: []                  # code-platform connections (including token and other auth fields)
active_connection_id: ''         # the single currently enabled connection id (only one enabled at a time)
llm:                             # multiple LLM profiles, switching the active one by active_id
  profiles: []                   # each with its own provider / model / base_url / api_key
  active_id: ''
  context_tokens: 128000         # input-context truncation cap (tokens, 32k~1M)
agent:                           # high-level Agent
  dir: ''                        # persona / knowledge / rules directory; empty = default location
  max_steps: 8                   # max steps per session
  summary_max_chars: 800         # cap on the wrap-up summary length
  autopilot: { enabled: false }  # AutoPilot pre-review (off by default; also holds batch_size / grants)
  strategy:                      # auto-review behavior strategy (shared by manual + AutoPilot)
    auto_followup: true          # whether to enable automatic follow-up asks
    max_followup_asks: 2
    max_code_suggestions: 4      # cap on code suggestions / findings per run (2~8)
poller: { interval_seconds: 300 } # polling interval (seconds, ≥30)
proxy: { enabled: false }        # outbound proxy; off by default = direct connection
notifications:                   # notifications; enabled is the master switch
  enabled: true
  new_pr: true                   # per-type system-notification switches
  reply: true
  mention: true
pr_agent:                        # pr-agent runtime
  strategy: auto                 # auto | embedded | local-cli
  max_concurrency: 2             # review concurrency (1~8)
update: { check_enabled: true }  # check for a new version at startup (prompt only, no auto-download)
workspace:
  repos_dir: ~/.code-meeseeks/repos  # the only data subdirectory relocatable to a large disk
```

- **Credential abstraction `SecretStore`**: `get` / `set` / `delete` — all token / API key reads/writes go through it, never touching `fs` directly, and credentials never enter logs / exception stacks.
- **Settings-related IPC** (a save takes effect immediately):
  - Per-item writes: `config:setConnections` / `setLlm` / `setProxy` / `setAgent` / `setPoller` / `setReposDir` / `setNotifications`;
  - Read: `config:read`;
  - Connectivity tests: `config:testConnection` / `config:testProxy` (ping / proxy connectivity);
  - Other: "Open the config file with the system-associated program".

## Extension & caveats

- **Credentials stored in plaintext**: the current security model — tightened file permissions + documented risk warning; acceptable for a developer audience. When switching to keytar, only the `SecretStore` implementation changes.
- **Config backward compatibility**: any new field must carry a default (zod `.default`) and consider migration from the old shape (e.g. the compatibility of migrating LLM from a single config to profiles).
- **Changing `repos_dir`** is a low-frequency operation and may require a restart / suspending polling.
- `~/.code-meeseeks/` is not relocatable (only `repos_dir` can move to a large disk); config/state/logs are small in total, and a fixed path makes backups easy to locate.
