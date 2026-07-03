# Installation & First Use

**English** · [简体中文](zh-CN/00-getting-started.md)

## System requirements

- **Operating system**: Windows 10 / 11 (x64) or macOS (Apple Silicon / arm64). Intel Mac and Linux installers are not currently provided.
- **git**: git must be installed on your machine and on your PATH. The client relies on system git to clone repositories and read local diffs.
- Reviewing and generating content requires a working LLM (see [LLM setup](02-llm.md)); the embedded runtime is bundled with the app, so no separate Python or Docker install is needed.

## Installation

Download the installer for your platform from the project's GitHub Releases page:

- **Windows**: `code-meeseeks-<version>-win-x64.exe` (NSIS installer) — double-click and follow the prompts.
- **macOS**: `code-meeseeks-<version>-mac-arm64.dmg` — open it and drag the app into "Applications".

### First launch on macOS

The current macOS package is ad-hoc signed and not notarized, so the first launch is blocked by the system. Allow it with any one of these:

- In "Applications", **right-click the app → Open → Open anyway**;
- Or **System Settings → Privacy & Security**, and click "Open Anyway" at the block prompt;
- Or run in a terminal: `xattr -dr com.apple.quarantine "/Applications/Code Meeseeks.app"`.

## First use

The first launch automatically creates the data directory and opens the **setup wizard**, guiding you to a working state as quickly as possible:

1. Configure a **code platform connection** — see [Code platform setup](01-code-platform.md).
2. (Optional) Configure an **LLM** — see [LLM setup](02-llm.md). You can browse PRs without one, but `/describe` and `/review` require a working LLM.

Once the wizard is done, the client starts polling and lists the PRs awaiting your review.

## Next steps

- Select a PR: view the diff, run `/describe` and `/review`, and comment / approve / merge.
- On an intranet / restricted network: configure the [network proxy](03-proxy.md) first.
- Already have a Claude / Codex subscription: use [local CLI mode](02-llm.md#local-cli-mode) to run reviews under your machine's login session.
