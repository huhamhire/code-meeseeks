# User Guide

**English** · [简体中文](zh-CN/README.md)

Code Meeseeks is a locally-run PR review client: connect to your code platform → pull the PRs awaiting your review → run `/describe` and `/review` with an LLM (pr-agent), and do all commenting / approving / merging right in the local client.

This directory is the **user-facing** installation and configuration guide (for development / architecture docs see [../arch/](../arch/README.md)). Every setting is visually editable on the in-app **Settings** page, and a first-launch setup wizard guides you to a working state as quickly as possible.

## Contents

| Document | Covers |
| --- | --- |
| [00 · Installation & first use](00-getting-started.md) | System requirements, download & install, first-launch setup wizard |
| [01 · Code platform setup](01-code-platform.md) | Connecting GitHub / Bitbucket Server / GitLab: Base URL, access token (PAT) permissions, clone protocol |
| [02 · LLM setup](02-llm.md) | Choosing an LLM provider and model; includes the advanced local CLI mode (invoke your machine's agentic CLI, with your authorization, to run reviews under its local session) |
| [03 · Network proxy setup](03-proxy.md) | Route all outbound traffic through an HTTP proxy on intranet / restricted networks |
| [04 · Config file reference](04-config-reference.md) | Full structure of `config.yaml` and every field's purpose (including advanced parameters) |
| [05 · Custom review rules](05-rules.md) | Writing rule `.md` files: frontmatter match conditions + body instructions injected into the AI |
| [06 · CLI tool](06-cli.md) | Enable the local API service + use the `meebox` CLI to browse PRs / drive the review agent (for scripts / external agent integration) |

## General notes

- **Fixed data directory** `~/.code-meeseeks/`: config, state, and logs all live here; `config.yaml` is the sole config file, holding all connection / LLM / proxy settings.
- **Credential safety**: configure access tokens, API keys, proxy passwords, etc. with least privilege, and revoke leaked tokens promptly.
- **Save takes effect immediately**: each setting is written to disk and hot-reloaded on save, no restart needed; connection / proxy changes are rebuilt and applied instantly.
- **Advanced editing**: the Settings page offers "Open config.yaml with the system default app" so you can edit the file directly (handy for bulk / advanced configuration).
