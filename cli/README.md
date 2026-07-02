# meebox CLI

A standalone, cross-platform command-line client for **Code Meeseeks**. It is a
thin client over the desktop app's local HTTP API — see the design docs:

- [Service listener & local API](../docs/arch/04-integration/01-service-api.md)
- [CLI tool](../docs/arch/04-integration/02-cli.md)
- Usage guide: [docs/guide/06-cli.md](../docs/guide/06-cli.md)

It provides PR browsing plus review write actions (approve / needs-work / comment);
merging and the agent's publish/mutating tools are intentionally not exposed.

`meebox` is also shipped as a drop-in agent **skill** — each release archive bundles
[`SKILL.md`](SKILL.md) beside the binary, so unzipping it into an agent's skills
directory yields a working skill.

## Build & run

This is an independent Go module (`go.mod`), not part of the npm/Nx workspace.

```bash
cd cli
go build -o bin/meebox .      # or: go install .
go vet ./...
go test ./...
```

Cross-compile (matches the release matrix):

```bash
GOOS=windows GOARCH=amd64 go build -o dist/meebox.exe .
GOOS=darwin  GOARCH=arm64 go build -o dist/meebox .
GOOS=linux   GOARCH=amd64 go build -o dist/meebox .
GOOS=linux   GOARCH=arm64 go build -o dist/meebox .
```

## Connection

The CLI resolves the API base URL and bearer token in this order (highest first):

1. flags — `--api-url`, `--token`
2. env — `MEEBOX_API_URL`, `MEEBOX_TOKEN`
3. CLI config — `~/.code-meeseeks/cli.yaml` (`api_url`, `token`)

Connection details must be provided explicitly; the CLI does **not** read the app's
`~/.code-meeseeks/config.yaml` (which holds connection-layer secrets). The API URL
defaults to `http://127.0.0.1:18765` when unset.

## Commands

Root-level `whoami` / `version` need no PR. Two domains — `pr` (also holds `categories`
and `refresh`) and `agent` — carry PR-scoped commands via the required `--pr <id>` flag
(`id` comes from `pr list`):

```text
meebox whoami
meebox version                          # CLI (client) + app (server) versions
meebox pr categories
meebox pr refresh                       # trigger one immediate poll for the latest PRs
meebox pr list [--category <filter>] [--status <key>] [--query <text>] [--skip N] [--limit N]
meebox pr show     --pr <id>
meebox pr diff     --pr <id> [--file <path>] [--side base|head]
meebox pr activity --pr <id>
meebox pr commits  --pr <id>
meebox pr reviewers --pr <id>
meebox pr approve  --pr <id>            # real remote review decision
meebox pr needswork --pr <id>           # real remote review decision
meebox pr comment  --pr <id> <message>  # real remote comment
meebox agent status   --pr <id>
meebox agent history  --pr <id>
meebox agent review   --pr <id>
meebox agent instruct --pr <id> <command> [args...]   # read-only: describe|review|ask|improve
meebox agent chat     --pr <id> <message>
meebox agent stop     --pr <id>                         # stop the whole PR agent
meebox agent run list --pr <id>
meebox agent run cancel --pr <id> --run <runId>         # cancel one pr-agent run
```

Global flags: `--api-url`, `--token`, `--output yaml|json`, `--quiet`.

Output defaults to **YAML** (human-friendly, k8s `-o yaml` style); pass
`--output json` for the machine-readable form used by third-party integrations.
Both preserve the server's field order (no per-command formatting).
