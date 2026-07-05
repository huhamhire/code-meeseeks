# Architecture overview

## Responsibilities & boundaries

This doc gives the overall architecture and the relationships between modules, serving as the entry point to the rest of the module docs. Specific designs live in the individual docs.

Form factor: a single-user **local desktop application** (Electron), no server, no multi-user sync. The main process (Node) carries all
business logic and IO; the render layer (React) only does display and interaction, calling the main process over IPC.

## Core design

### Process model

- **Main (Node + TS)**: the sole home of business logic and IO — polling, repo mirror, running pr-agent, state reads/writes, publishing comments.
  Single writer, exclusive owner of the state directory, no file lock needed.
- **Renderer (React)**: the UI (PR list / Diff / conversation / drafts). `contextIsolation` on, no `nodeIntegration`, under CSP.
- **Preload**: exposes, via `contextBridge`, only a single generic `invoke(channel, req)` plus a few event subscriptions, exposing no Node capabilities.

### IPC

Renderer ↔ Main all goes through `ipcMain.handle(channel, …)` + the render-side generic `invoke<K>(channel, req)`, with a single
centralized `IpcChannels` type map constraining request/response types. Adding an interaction = first add the channel type to that map, then implement both sides.
(Note: tRPC was considered early on; what shipped is this hand-written type map.)

### Data flow (the main path of one review)

```mermaid
flowchart TB
  subgraph discover[Discover]
    poller[Poller] -->|pull "PRs to review" per connection| state[(State storage<br/>per-PR directory)]
  end

  subgraph review[Review one PR]
    direction TB
    pick([User selects a PR]) --> mirror[Repo mirror<br/>sync bare + materialize worktree]
    cmd(["/review · /describe · /ask"]) --> bridge[pr-agent bridge<br/>run embedded pr-agent on the worktree]
    mirror --> bridge
    bridge --> parse[Output parsing → findings]
    parse --> drafts[Draft pool]
    drafts --> confirm([User confirms / edits])
    confirm --> publish[Batch publish → platform Adapter]
  end

  state -.select.-> pick
```

### Module map (packages / main-process subsystems)

- **`01-platform/`** — Platform integration & PR operations
  - [Code-platform adaptation](01-platform/01-adapter.md) — `platform-bitbucket-server` + the `PlatformAdapter` abstraction
  - [Repo mirror & Diff](01-platform/02-repo-mirror.md) — `repo-mirror`
  - [Review→publish loop](01-platform/03-review-workflow.md) — `poller` (output parsing) + main-process drafts / publish
  - [Comment interactions](01-platform/04-comment-interactions.md) — render-layer comment UI + Adapter reaction / attachment capabilities
- **`02-agent/`** — Agent & rules
  - [Agent & context](02-agent/01-agent.md) — Agent directory / context injection / tool mutation red line
  - [Agentic sessions](02-agent/02-session.md) — natural-language delegation + planning loop
  - [AutoPilot & scheduling](02-agent/03-autopilot.md) — automatic pre-review + priority queue
  - [Rules system](02-agent/04-rules.md) — `rules`
  - [pr-agent integration & runtime](02-agent/05-pragent-runtime.md) — `pr-agent-bridge` + embedded runtime
- **`03-gui/`** — GUI & interaction
  - [GUI & interaction](03-gui/01-ui-interaction.md) — render-layer React (layout / panels / cross-PR state persistence)
  - [Command palette](03-gui/02-command-palette.md) — render-layer title-bar entry + domain-grouped command registry
  - [Notifications](03-gui/03-notifications.md) — `poller` event projection + main-process system notifications / dock badge
  - [Internationalization](03-gui/04-i18n.md) — react-i18next + dual main / render runtime locale
- **`04-integration/`** — External integration extensions & CLI
  - [Local API service & listener](04-integration/01-service-api.md) — main-process built-in HTTP API (a second front-end beyond IPC)
  - [CLI tool](04-integration/02-cli.md) — standalone Go binary, consuming app capabilities via the local API
- **`99-core/`** — Infrastructure
  - [State storage & data model](99-core/01-state-storage.md) — `state-store` + the `poller`'s pr-state
  - [Config & credentials](99-core/02-config-and-secrets.md) — `config` + settings page
  - [Outbound network & proxy](99-core/03-networking-proxy.md) — main-process proxy plumbing
  - [Error codes & propagation](99-core/04-error-codes.md) — `shared`'s `AppError` + cross-IPC encoding

> Packaging / build / signing: see the development topic [`../development/packaging-release.md`](../development/packaging-release.md) (not a product subsystem).

`shared` holds cross-package shared types (including the `IpcChannels` contract and PR/Finding/Run and other domain types); `logger` is the unified logging.

### Engineering baseline

- npm workspaces + Nx monorepo; unified `lint`/`typecheck`/`test`/`build` tasks (see the root `AGENTS.md`).
- Desktop shell Electron + electron-vite; rendering React + Monaco (side-by-side/inline diff).

### Data & privacy boundary

- **Local-first**: repo copies, PR metadata, comment cache, drafts, and config all stay in the local working directory `~/.code-meeseeks/`
  (the repo mirror can be redirected to `repos_dir`). No server, no multi-user sync.
- **Only two kinds of outbound** (nothing else is reported to any third party; both kinds can be governed through a unified HTTP proxy, see [Networking & proxy](99-core/03-networking-proxy.md)):
  - the reviewer's self-configured **LLM API** (via pr-agent / litellm);
  - the configured **code platform** (PR / comment REST + git fetch).
- **What is sent to the LLM**: when pr-agent reviews, it sends only the **PR diff + matched rules** (extra_instructions) to the LLM, nothing else from local data.
- **Credentials**: the platform token / LLM API key / proxy password are stored in **plaintext** in `config.yaml` (with tightened file permissions), a known risk;
  the abstraction layer reserves a keytar upgrade (see [Config & credentials](99-core/02-config-and-secrets.md)).
- **Security baseline**: the render layer has `contextIsolation` on, no `nodeIntegration`, CSP; preload exposes only whitelisted capabilities (see [GUI interaction](03-gui/01-ui-interaction.md)).

## Data / interface contract

- **IPC contract**: centralized in `shared`'s `IpcChannels` type map (`channel → { request, response }`).
- **Domain types**: PR (`StoredPullRequest` / `PrIdentity`), comment (`PrComment`), review run (`ReviewRun`, including
  `findings` / `tokenUsage`), and the platform abstraction (`PlatformAdapter`) all live in `shared`, shared across packages.

## Extension & caveats

- **Adding a new code platform**: implement `PlatformAdapter`; the business layer (Poller/publish/mirror) is agnostic to the specific platform. See [Platform adaptation](01-platform/01-adapter.md).
- **Cross-process capabilities** always go through an IPC channel + type map; don't touch Node / files / network directly in the render layer.
- Each doc describes the "current implementation"; when it evolves, just update the corresponding doc in sync.
