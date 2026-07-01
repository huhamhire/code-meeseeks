# meebox CLI

A standalone, cross-platform command-line client for **Code Meeseeks**. It is a
thin client over the desktop app's local HTTP API — see the design docs:

- [Service listener & local API](../docs/arch/04-integration/01-service-api.md)
- [CLI tool](../docs/arch/04-integration/02-cli.md)

All exposed capabilities are **read-only**; write operations (commenting,
approving, publishing) are intentionally not provided.

## Status

Project scaffold. The command tree, connection/auth resolution, HTTP client,
output formatting, and exit-code mapping are in place and built against the
documented API contract. The server-side API is implemented separately; until
it is available, commands will fail to connect.

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
3. CLI config — `<user-config-dir>/meebox/cli.yaml` (`api_url`, `token`)
4. local auto-discovery — the app's `~/.code-meeseeks/config.yaml` `service`
   section (same machine, same user; zero-config)

## Commands

```text
meebox categories
meebox pr list [--primary <filter>] [--secondary <key>] [--query <text>]
meebox pr show <id>
meebox pr diff <id> [--file <path>] [--side base|head]
meebox pr activity <id>
meebox pr commits <id>
meebox pr reviewers <id>
meebox agent status <id>
meebox agent history <id>
meebox agent review <id>
meebox agent instruct <id> <command> [args...]   # read-only: describe|review|ask|improve
meebox agent chat <id> <message>
```

Global flags: `--api-url`, `--token`, `--output yaml|json`, `--quiet`.

Output defaults to **YAML** (human-friendly, k8s `-o yaml` style); pass
`--output json` for the machine-readable form used by third-party integrations.
Both are generic transforms of the response — no per-command formatting.
