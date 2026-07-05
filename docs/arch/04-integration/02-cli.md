# CLI tool (meebox)

## Responsibilities & boundaries

Provide an **independently distributed cross-platform command-line client** that consumes the app's capabilities through the
[local API](01-service-api.md), so external agents / scripts / CI can fold meebox's PR discovery, browsing, and Agent
operations into automation flows. The command is named **`meebox`**.

Responsible for: wrapping API endpoints into a handy command tree, parsing connection / auth config, output for two
consumption modes (human / machine — text / JSON), and an exit-code convention. It provides browsing and **review write
actions** (approve / needswork / comment) — consistent with the server's write boundary.

**Not responsible for**:

- Business logic — the CLI is a thin client over the API and embeds no review / platform logic.
- **Merge and change-type Agent tools** (merge / publish, etc.) — no corresponding commands; the API itself does not expose
  them (see [server write boundary](01-service-api.md)).
- The desktop app itself — the CLI is **not embedded in the installer**; it is an independent distributable (see
  "Distribution" below).

## Core design

### Tech-stack and repo-shape decision (Go evaluation)

The preferred tech stack for the CLI is settled as **Go**, and the "whether to embed it in the current project" question has a
conclusion — **the question has two layers, with different conclusions**:

1. **Whether to bundle it into the Electron installer: no.** The CLI targets external automation and talks to the app over
   HTTP; it need not ship with the desktop package, and bundling it would only needlessly bloat the install size. The two are
   **independent distributables**.
2. **Whether to place the source in this repo (monorepo): yes, but as a standalone top-level `cli/` directory with its own
   `go.mod`, not part of npm workspaces / Nx.** Go has its own module system and build cache, incompatible with the npm/Nx
   engineering model; forcibly wrapping it into an Nx project (a run-commands shell) adds complexity and makes the Go toolchain
   a prerequisite for whole-repo development. The CLI's **only coupling with the main project is the HTTP/JSON wire protocol**
   (language-agnostic), with no code-level sharing, so "same repo, independent build" is the most natural.

**Why Go suits this CLI**: a small statically linked binary, cross-compilation for all platforms with a single
`GOOS`/`GOARCH` command, fast startup, no runtime dependency — exactly the ideal shape for a distribution CLI. Compared with
bundling Node/TS via pkg / SEA (tens of MB, fragile cross-compilation, slow cold start), Go is clearly ahead on distribution
experience.

**Cost and mitigation — type-contract sync**: the Go side cannot reuse `shared`'s TS types at compile time.

- **Initially**: the API endpoints are few and stable, so **hand-written Go structs aligned to the doc contract** suffice
  (low cost).
- **Later**: if the contract grows, introduce OpenAPI / JSON Schema as the single source of truth, generating TS-side
  validation + a Go-side client to eliminate manual drift.

### Connection and authentication

The CLI needs an API base URL + token. Source priority (high → low):

1. Command-line flags: `--api-url` / `--token`;
2. Environment variables: `MEEBOX_API_URL` / `MEEBOX_TOKEN`;
3. The CLI's own config file `~/.code-meeseeks/cli.yaml` (same directory as the GUI's `config.yaml` but a separate file,
   isolating the two configs).

Connection info must be **explicitly provided** (one of flag / environment variable / `cli.yaml`); a missing token raises an
auth error. `meebox login --token <token> [--server <url>]` writes the token (and an optional server, defaulting to loopback)
into `cli.yaml`, saving passing arguments every time thereafter — it is the CLI's only config **write** command, paired with
the reading of `cli.yaml` (the priority above), making config management self-contained.

**Does not read the GUI's main config**: the CLI deliberately does **not** read the app's main config
`~/.code-meeseeks/config.yaml`. That file carries connection-layer secrets (access tokens for each code platform, etc.);
silently taking the service token from it would let the CLI reach credentials it should not touch — an out-of-scope
over-reach, so the earlier "local auto-discovery" design was removed. The environment variable `MEEBOX_TOKEN` is the
recommended way to avoid passing arguments each time on a local machine (paired with shell / CI environment injection).

### Command structure

```text
meebox [global flags] <group> <command> [args]

global flags: --api-url · --token · --output (yaml|json) · --quiet
```

Commands fall into two classes — **root-level system commands** and **two domain groups**:

- **System commands (root level)** — `login` (save credentials to `cli.yaml`), `whoami` (identity), `version` (client +
  server version), `skill` (print the embedded SKILL.md): tool / session-level operations unrelated to a specific PR / Agent,
  placed directly at the root level without a domain group (following conventions like `kubectl version` / `gh auth`).
- **`pr`** — PR-related operations: browsing + review write actions, plus `categories` (the filter vocabulary for `pr list`)
  and `refresh` (trigger one fetch, refresh the PR list).
- **`agent`** — review Agent operations.

PR-scoped subcommands under `pr` / `agent` pass the PR identifier via the **required flag `--pr <id>`** (`id` is obtained from
`pr list` output) — agent is **not nested inside `pr`** (avoiding the duplicated `pr` in `pr agent … --pr`) and sits as a
peer of `pr`; the root-level system commands and `pr categories` / `pr refresh` / `pr list` are not PR-scoped and need no
`--pr`.

| Command | Purpose | Corresponding API |
| --- | --- | --- |
| `meebox login --token <token> [--server <url>]` | Save the token (and an optional server, defaulting to loopback) to `cli.yaml`, so later commands need no arguments | — (local write, no API) |
| `meebox whoami` | Current identity (user + platform + connection name) | `GET /whoami` |
| `meebox version` | Client (CLI) + server (app) version; when the server is unreachable, client only, exit code still 0 | `GET /version` |
| `meebox skill` | Print the agent usage guide (SKILL.md) embedded at build time via `go:embed` | — (local, no API) |
| `meebox pr categories` | List the category labels for the currently enabled platform (`categories` level one + `statuses` level two) — the filter vocabulary for `pr list` | `GET /categories` |
| `meebox pr refresh` | Trigger one immediate polling refresh (fetch the latest PRs, persist locally), returning this round's count summary (fetched / changed / added / removed / errors); equivalent to a GUI manual refresh | `POST /refresh` |
| `meebox pr list [--category <level one>] [--status <level two>] [--query <search>] [--skip N] [--limit N]` | PR list (compact projection + pagination, default limit 100) | `GET /prs` |
| `meebox pr show --pr <id>` | Description detail | `GET /prs/{id}` |
| `meebox pr diff --pr <id> [--file <path>] [--side base\|head]` | Without `--file`, list changed files; with it, fetch that file's content | `GET /prs/{id}/diff` |
| `meebox pr activity --pr <id>` | Activity (timeline) | `GET /prs/{id}/activity` |
| `meebox pr commits --pr <id>` | Commit list | `GET /prs/{id}/commits` |
| `meebox pr reviewers --pr <id>` | Reviewer approval status | `GET /prs/{id}/reviewers` |
| `meebox pr approve --pr <id>` | Review decision "approve" (real remote write) | `POST /prs/{id}/approve` |
| `meebox pr needswork --pr <id>` | Review decision "needs work" (real remote write) | `POST /prs/{id}/needswork` |
| `meebox pr comment --pr <id> <message>` | Post a top-level comment (real remote write) | `POST /prs/{id}/comment` |
| `meebox agent status --pr <id>` | The Agent's current execution status | `GET /prs/{id}/agent` |
| `meebox agent history --pr <id>` | Conversation history | `GET /prs/{id}/agent/conversation` |
| `meebox agent review --pr <id>` | Run auto review | `POST /prs/{id}/agent/review` |
| `meebox agent instruct --pr <id> <command> [args]` | Send an Agent instruction (read-only only: describe / review / ask / improve) | `POST /prs/{id}/agent/instruct` |
| `meebox agent chat --pr <id> <message>` | Natural-language chat (can trigger task execution) | `POST /prs/{id}/agent/chat` |
| `meebox agent stop --pr <id>` | Interrupt the running Agent for this PR (PR-level) | `POST /prs/{id}/agent/stop` |
| `meebox agent run list --pr <id>` | The pr-agent runs in this PR's run queue (active + waiting) | `GET /prs/{id}/agent/runs` |
| `meebox agent run cancel --pr <id> --run <runId>` | Cancel one pr-agent tool call by run | `POST /prs/{id}/agent/runs/{runId}/cancel` |

- `<id>` is the PR's `localId` (named `id` externally in the list projection, obtained from `pr list` output).
- Review write actions go through the dedicated `pr approve` / `pr needswork` / `pr comment` commands; change-type tools
  (publish, etc.) are not in the `instruct` whitelist and are rejected by the server if passed (the CLI also errors friendly
  up front). merge is not provided.
- Interrupt granularity: `agent stop` stops the entire PR's Agent; `agent run cancel` cancels only the specified single
  pr-agent run.

### Output and exit codes

- **`--output yaml` (default)**: render the response as YAML (like k8s `-o yaml`) — structured yet readable, convenient for
  interactive human viewing. Like JSON, it is a **generic transform** of the response data, without per-command tables /
  formatters (sparing the contract-sync burden of hand-written structs).
- **`--output json`**: output the API `data` verbatim, for external agents / scripts to consume by machine. Passing arguments
  has no barrier for an agent, so the default is optimized for humans (YAML) while machine integration explicitly takes
  `json`; both have the same-source field shape and are both stable.
- **Exit-code convention**: `0` success; non-zero for errors, distinguished by category (e.g. `2` auth failure, `3` resource
  not found, `1` generic error); error messages go to `stderr`, carrying the error code returned by the server (`ESV*`, etc.)
  for scripts to branch on.

### Implementation choices

- Go + a command-tree library (e.g. cobra) + the standard `net/http` client, **minimal dependencies**.
- Error codes / response envelope align one-to-one with the server contract (see [server contract](01-service-api.md)).

## Data / interface contract

- **Config source priority**: flag > env (`MEEBOX_API_URL` / `MEEBOX_TOKEN`) > CLI config file
  (`~/.code-meeseeks/cli.yaml`). Connection info must be explicitly provided; the CLI does not read the GUI's main config
  `config.yaml` (which holds connection-layer secrets).
- **Output modes**: `yaml` (default, human, like k8s `-o yaml`) / `json` (machine, outputs the API `data`); both are generic
  transforms of the response data.
- **Exit codes**: `0` success / `1` generic / `2` auth / `3` not found (extended as needed).
- **Binary and archive naming**: `meebox-cli-<version>-<os>-<arch>.<ext>` (Windows / macOS use `.zip`, Linux uses `.tar.gz`),
  with a `.sha256` checksum. `<version>` is taken from `apps/desktop/package.json` (same source as the app, the single source
  of truth), verified against the `v*` tag as a release prerequisite.
- **Archive content = a directly droppable skill directory**: besides the binary it also packages `LICENSE` + `README.md` +
  `SKILL.md`. Extracting it into an agent's skills directory yields a usable skill — `SKILL.md` (frontmatter `name: meebox`)
  teaches the agent the usage, right next to the binary it drives. This is the CLI's primary "delivery to agents" form.
- **Binary self-description (`go:embed`)**: the same `SKILL.md` is embedded into the binary at build time via `go:embed`, and
  `meebox skill` prints it. Even a binary separated from its archive (e.g. `go install` or dropped bare onto `PATH`) can
  describe its own usage, and the embedded content matches the packaged `SKILL.md` at build time. It deliberately **does not**
  produce a `--manifest`-style function-calling JSON — a skill's consumption form is markdown, not tool-schema injection; if
  that need arises it should be generated from the command tree, not maintained separately as JSON.

## Distribution & CI

- **Platform coverage**: Windows x64, macOS arm64, Linux x64 / arm64.
- **Released together with the main project**: the release flow's **Go build job** (`actions/setup-go` + `GOOS`/`GOARCH`
  cross-compilation matrix) produces four-platform archives (binary + `LICENSE` + `README.md` + `SKILL.md`) + checksums, and
  uploads them alongside the desktop installer to the **same GitHub Release** (triggered by the existing `v*` tag, see
  [release flow](../../../AGENTS.md)).
- The version number is **taken from `apps/desktop/package.json` (same source as the app)** and injected into `cmd.version` via
  `-ldflags` — it does not independently depend on the git tag (the tag is verified against it as a release prerequisite),
  ensuring the CLI and server API contract versions correspond.
- **One-shot install script (macOS / Linux)**: `tools/cli/install.sh` installs in one `curl … | bash` command — detect system
  / architecture → fetch the matching Release archive → verify SHA-256 → extract `meebox` and install it onto `PATH` (default
  `/usr/local/bin`, falling back to `~/.local/bin` if not writable; `MEEBOX_VERSION` / `MEEBOX_BIN_DIR` can override). It
  deliberately **does not lay down `SKILL.md`** (already embedded, exportable via `meebox skill`). Windows is not covered by
  the script; use manual download.

## Extension & caveats

- **Write boundary consistent with the server**: only review write actions are provided (approve / needswork / comment);
  merge and change-type Agent tools are not. Before adding a command, first confirm the corresponding API endpoint exists; a
  write command must align with the server write boundary.
- **Add the endpoint before a new command**: the CLI must not bypass the API to reach app internals directly; fill a
  capability gap by adding an endpoint on the [server](01-service-api.md) first.
- **Do not touch GUI secrets**: the CLI does not read the app's main config `~/.code-meeseeks/config.yaml` (which holds
  connection-layer secrets such as per-platform access tokens); the service token must be explicitly provided via flag /
  environment variable / `cli.yaml`, avoiding over-reaching to out-of-scope credentials.
- **Contract-drift protection**: initially, be sure to keep hand-written structs updated in sync with the server contract;
  once the contract grows, switch to OpenAPI / Schema code generation.
- **Version compatibility gating**: the CLI carries the `X-Meebox-CLI-Version` header on every request declaring its own
  version (same source as the app); the server gates uniformly by its centrally managed minimum compatible version, and on
  receiving `SV_CLIENT_TOO_OLD` (HTTP 426) the CLI prints a "too old, please upgrade" message. See the "CLI version
  compatibility gating" in the [server contract](01-service-api.md).
- **JSON stability first**: `--output json` is the main automation path; its field shape is treated as an external contract
  and must stay compatible as it evolves.
- **Proxy via environment variables**: the HTTP client uses Go `net/http`'s default transport, naturally honoring the standard
  `HTTP(S)_PROXY` / `NO_PROXY`; loopback (`127.0.0.1` / `localhost`) connects directly by default without a proxy — no need to
  implement proxy logic ourselves.
