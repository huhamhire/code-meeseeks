---
name: meebox
description: Review and act on pull requests through the Code Meeseeks "meebox" CLI — list and inspect PRs, run the AI review agent, and record review outcomes (approve / needs-work / comment). Use when the user wants to triage, review, or act on pull requests via a running Code Meeseeks desktop app.
---

# meebox — pull-request review over the local API

`meebox` is a thin cross-platform CLI over a running **Code Meeseeks** desktop app's
local HTTP API. Use it to browse pull requests, drive the review agent, and record
review outcomes. Output defaults to YAML; pass `--output json` when parsing results.

## Prerequisites

- The Code Meeseeks desktop app is running with the local API service **enabled**
  (Settings → Integration).
- The `meebox` binary is available — it ships in this skill directory; put it on `PATH`
  or invoke it by path (`./meebox`).
- Connection is configured (below). Verify with `meebox whoami`.

## Connect

Provide the API base URL + token explicitly — the CLI never reads the app's `config.yaml`:

```bash
export MEEBOX_API_URL=http://127.0.0.1:18765   # default port; override for remote hosts
export MEEBOX_TOKEN=<token>                     # from Settings → Integration
meebox whoami                                    # confirm the resolved user + platform
meebox --output json pr list | jq '.[].id'       # JSON for scripting
```

## Command map

Two domains, both PR-scoped via the **required `--pr <id>`** flag (`id` comes from `pr list`):

**Browse / inspect — `pr`**
- `meebox pr list [--category review-requested|created|assigned|mentioned] [--status pending|approved|needs_work|conflict|mergeable] [--query <text>] [--skip N] [--limit N]` — paginated (default limit 100), slim fields (id / title / author / createdAt first).
- `meebox pr show --pr <id>` — full detail incl. description.
- `meebox pr diff --pr <id> [--file <path> --side base|head]` — changed files, or one file's content.
- `meebox pr activity --pr <id>` · `meebox pr commits --pr <id>` · `meebox pr reviewers --pr <id>`.

**Review agent — `agent`**
- `meebox agent review --pr <id>` — run the auto-review micro-flow (describe→review→[ask]→summary).
- `meebox agent status --pr <id>` · `meebox agent history --pr <id>` — progress + conversation.
- `meebox agent instruct --pr <id> <describe|review|ask|improve> [text]` — one read-only tool call.
- `meebox agent chat --pr <id> <message>` — natural-language message (may trigger tasks).
- `meebox agent run list --pr <id>` · `meebox agent run cancel --pr <id> --run <runId>` — inspect / cancel a single agent run.
- `meebox agent stop --pr <id>` — stop the whole agent for the PR.

**Record outcomes — `pr` (real remote writes)**
- `meebox pr approve --pr <id>` · `meebox pr needswork --pr <id>` — post a review decision.
- `meebox pr comment --pr <id> <message>` — post a top-level comment.

Filter vocabulary: `meebox categories` lists the active platform's available `categories` / `statuses`.

## Typical loop

1. `meebox --output json pr list --status pending` → choose a PR `id`.
2. `meebox pr show --pr <id>` and/or `meebox agent review --pr <id>`; poll `meebox agent status --pr <id>`.
3. Inspect changes: `meebox pr diff --pr <id>`.
4. Record the outcome: `meebox pr approve --pr <id>` / `meebox pr needswork --pr <id>` / `meebox pr comment --pr <id> "…"`.

## Boundaries

- **Not available**: merging PRs, and the agent's publish / mutating tools — `instruct` accepts
  only the read-only tools `describe` / `review` / `ask` / `improve`.
- Exit codes: `0` ok · `2` auth failure · `3` not found · `1` other; errors print to stderr with the API error code.
