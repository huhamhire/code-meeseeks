# CLI Tool (meebox)

**English** · [简体中文](zh-CN/06-cli.md)

`meebox` is the cross-platform command-line tool shipped with each release. It reaches the app's capabilities through the local "local API service", making it easy to wire PR browsing and review-agent operations into scripts, CI, or an external agent. The CLI provides **browsing and review actions**, including review decisions (approve / needswork) and posting comments; it does not include high-impact write operations such as merge.

## 1. Enable the local API service

The CLI depends on the app's local API service, which is off by default and must first be enabled under **Settings → Integration**:

- Turn on the "Local API service" toggle (the first time you enable it, an access token is generated automatically).
- **Listen address**: defaults to `http://127.0.0.1:18765` (reachable only from the local machine). To let other machines / CI on the same network reach it, change the host to `0.0.0.0` or your machine's LAN IP — at that point **the token is the only line of defense**, so keep it secret and pair it with a firewall.
- **Access token**: can be shown / copied / regenerated; regenerating invalidates the old token immediately.

## 2. Get the CLI

**One-line install on macOS / Linux** — downloads the latest version, verifies its SHA-256, and installs to `PATH`:

```bash
curl -fsSL https://raw.githubusercontent.com/huhamhire/code-meeseeks/main/tools/cli/install.sh | bash
```

The script auto-detects your OS / architecture, pulls the matching Release archive, and installs `meebox` to `/usr/local/bin` (falling back to `~/.local/bin` if that isn't writable). Use the environment variables `MEEBOX_VERSION` (install a specific version) and `MEEBOX_BIN_DIR` (specify the install directory) to adjust. There's no need to install `SKILL.md` separately — it's embedded in the binary (`meebox skill` prints it).

**Manual download** (Windows, or when the script is inconvenient): from the [GitHub Release](https://github.com/huhamhire/code-meeseeks/releases), download the archive for your platform (`meebox-cli-<version>-<os>-<arch>.zip` / `.tar.gz`), extract it, and put `meebox` on your `PATH`.

Covered platforms: Windows x64, macOS arm64, Linux x64 / arm64. The archive contains the `meebox` binary, `LICENSE`, `README.md`, and `SKILL.md` (for dropping in as an agent skill, see [section 6](#6-integrating-as-an-agent-skill)).

## 3. How to connect

`meebox` resolves the API address and token in the following priority order (high → low):

1. Command-line flags: `--api-url` / `--token`
2. Environment variables: `MEEBOX_API_URL` / `MEEBOX_TOKEN`
3. CLI config file: `~/.code-meeseeks/cli.yaml` (fields `api_url` / `token`)

Connection info must be **provided explicitly** by one of these. View / copy the token in the "Integration" section of the Settings page. The easiest approach is to store the token once with `meebox login` (written to `cli.yaml`), after which all commands need no arguments:

```bash
meebox login --token <token>            # connects to http://127.0.0.1:18765 by default
meebox login --token <token> --server http://<host>:18765   # specify a remote service
meebox pr list                          # subsequent commands use the stored credentials
```

Or use environment variables (handy for CI / shell injection):

```bash
export MEEBOX_API_URL=http://127.0.0.1:18765
export MEEBOX_TOKEN=<token>
meebox pr list
```

Remote access (service listening on `0.0.0.0`) likewise provides the address and token explicitly:

```bash
meebox --api-url http://<host>:18765 --token <token> pr list
```

> The CLI **does not read** the GUI's main config `~/.code-meeseeks/config.yaml`: that file holds connection-layer secrets such as code-platform access tokens, and the service token is not taken from it, to avoid over-reaching into credentials it doesn't need. The API address defaults to `http://127.0.0.1:18765` (when not specified explicitly).

## 4. Commands

```text
meebox [global flags] <group> <command> [args]
```

The root-level system commands `whoami` / `version` are unrelated to any specific PR; the rest are split into two domain groups — `pr` (PR operations, including the `categories` filter vocabulary and `refresh`) and `agent` (review-agent operations). Their PR-scoped subcommands specify the PR with the **required flag `--pr <id>`** (the `id` comes from `meebox pr list` output).

| Command | Purpose |
| --- | --- |
| `meebox login --token <token> [--server <address>]` | Save the token (and optional service address) to `cli.yaml`; subsequent commands need no arguments |
| `meebox whoami` | Current login identity and integrated platform (user + platform + connection name) |
| `meebox version` | Client (CLI) + server (app) version; when not connected to a server, only the client version is shown |
| `meebox skill` | Print the embedded usage guide (SKILL.md), so the binary can describe its own usage when separated from the archive |
| `meebox pr categories` | List the category labels available on the current platform (top-level discovery categories + second-level status / merge-state filters) — the filter vocabulary for `pr list` |
| `meebox pr refresh` | Trigger an immediate refresh (fetch the latest PRs), returning this round's change counts (added / changed / removed, etc.); equivalent to the manual refresh in the GUI |
| `meebox pr list [--category <top-level>] [--status <second-level>] [--query <search>] [--skip N] [--limit N]` | PR list (compact fields + pagination, default limit 100) |
| `meebox pr show --pr <id>` | PR description details |
| `meebox pr diff --pr <id> [--file <path>] [--side base\|head]` | Without `--file`, list changed files; with it, fetch that file's content |
| `meebox pr activity --pr <id>` | Activity timeline (comments / commits / review decisions) |
| `meebox pr commits --pr <id>` | Commit list |
| `meebox pr reviewers --pr <id>` | Reviewer approval status |
| `meebox pr approve --pr <id>` | Mark the PR as "approved" (sends a real review decision to the platform) |
| `meebox pr needswork --pr <id>` | Mark the PR as "needs work" (sends a real review decision to the platform) |
| `meebox pr comment --pr <id> <message>` | Post a top-level comment to the platform |
| `meebox agent status --pr <id>` | The review agent's current execution status |
| `meebox agent history --pr <id>` | Session history |
| `meebox agent review --pr <id>` | Run an automatic review |
| `meebox agent instruct --pr <id> <instruction> [args]` | Send a review instruction (`describe` / `review` / `ask` / `improve`) |
| `meebox agent chat --pr <id> <message>` | Send a natural-language message (may trigger an agent task) |
| `meebox agent stop --pr <id>` | Interrupt the running review agent for this PR (stops it as a whole) |
| `meebox agent run list --pr <id>` | List the running / queued pr-agent runs for this PR |
| `meebox agent run cancel --pr <id> --run <runId>` | Cancel a single pr-agent tool call by run id |

Here `<id>` is the PR's local identifier (the `id` field in the list), obtained from `meebox pr list` output.

## 5. Output format

The global flag `--output`:

- **`yaml` (default)**: structured yet readable (like kubectl `-o yaml`), suited to a human viewing it in a terminal.
- **`json`**: suited to machine parsing by scripts / external agents.

```bash
meebox pr list --output json | jq '.[].title'
```

**Exit codes**: `0` on success; non-zero on error (`2` auth failure, `3` resource not found, `1` other); error messages go to `stderr`.

## 6. Integrating as an agent skill

`meebox`'s primary delivery form is a **ready-to-drop agent skill**: besides the binary, the release archive also contains `SKILL.md` / `README.md` / `LICENSE`, and the whole extracted directory is a usable skill.

- **Drop in and go**: put the extracted directory into the agent's skills directory (e.g. `~/.claude/skills/meebox/`). `SKILL.md` (frontmatter `name: meebox`) describes the command tree, connection method, and write boundaries to the agent, right next to the binary it drives.
- **Self-describing binary**: the same `SKILL.md` is embedded into the binary at build time via `go:embed`, and `meebox skill` prints it — so even when the binary is separated from the archive (e.g. placed alone on `PATH`), it can retrieve its usage, with content matching the packaged docs at build time.
- **Binary-only fallback**: if all you have is the `meebox` binary (no archive / `SKILL.md` file), `meebox skill` exports the guide from the binary and rebuilds the skill directory in place, with no need to hunt down the original files:

  ```bash
  mkdir -p ~/.claude/skills/meebox
  cp "$(command -v meebox)" ~/.claude/skills/meebox/      # put the binary into the skill directory
  meebox skill > ~/.claude/skills/meebox/SKILL.md          # export the guide from the embedded copy
  ```

  The exported content shares its source with that binary, so it naturally matches the current version.
- **Integration flow**: read `SKILL.md` to learn the capabilities → `meebox login` to store credentials once → browse and drive reviews with `meebox pr list` / `pr show` / `agent review`, etc. → record conclusions with `meebox pr approve` / `needswork` / `comment`; machine consumers uniformly use `--output json` (whose field shapes are a stable contract).
- **Boundaries built in**: only browsing + review write actions are exposed, with no merge or change-type tools (see "Notes" below), so agent integration inherently cannot trigger high-impact remote operations.
- **Framework-agnostic integration**: `SKILL.md` auto-discovery is a Claude Code skill convention, not a cross-framework standard. Other agents / scripts can integrate without relying on it — invoke `meebox` directly from the shell, get usage via `meebox skill` or `--help`, and get structured results via `--output json`. The truly portable interface is "command line + JSON"; `SKILL.md` auto-discovery is just a nice extra in the Claude ecosystem.

## Network proxy

`meebox` honors the standard HTTP proxy environment variables (`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`, any case), with no extra configuration:

- Access to the **local** service (`127.0.0.1` / `localhost`) connects directly, bypassing the proxy.
- Access to a **remote** service (e.g. a machine exposed via `0.0.0.0`) goes through `HTTP_PROXY` if set; use `NO_PROXY` to exclude specific hosts.

## Notes

- **Scope of write capability**: the CLI provides review write actions — `pr approve` / `pr needswork` (sending real review decisions) and `pr comment` (posting a top-level comment); but it **does not provide merge or change-type agent tools (publish, etc.)** — for those, integrate with the code platform yourself.
- **Token safety**: the service token is stored in plaintext in the GUI's `~/.code-meeseeks/config.yaml`; if written into the CLI's `~/.code-meeseeks/cli.yaml`, it is likewise plaintext. Keep it especially secret when listening on `0.0.0.0` exposes it to the LAN, and promptly revoke a leaked token via "Regenerate".
- **Version compatibility**: if `meebox`'s version is below the minimum the app requires, any command returns a "CLI too old, please upgrade" notice (with both versions); reinstall the latest per "Get the CLI" above. The CLI and app are released from the same source, so a normal in-sync upgrade won't hit this.
