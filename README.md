<div align="center">

<img src="assets/icons/icon.png" alt="Code Meeseeks" width="96" />

# Code Meeseeks

**A desktop GUI for PR-Agent · A local, semi-automated AI code-review client for the individual reviewer**

Graphical interface (GUI) for the community [PR-Agent](https://docs.pr-agent.ai/) · Electron desktop app · All data stays on your machine

[![Electron](https://img.shields.io/badge/Electron-2B2E3A?logo=electron&logoColor=9FEAF9)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Release](https://img.shields.io/github/v/release/huhamhire/code-meeseeks?include_prereleases&sort=semver&label=release&color=4c9a40)](https://github.com/huhamhire/code-meeseeks/releases)

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/)
[![Bitbucket](https://img.shields.io/badge/Bitbucket-0052CC?logo=bitbucket&logoColor=white)](https://bitbucket.org/)
[![GitLab](https://img.shields.io/badge/GitLab-FC6D26?logo=gitlab&logoColor=white)](https://gitlab.com/)

<sub>Keywords：PR-Agent GUI · pr-agent desktop client · AI code review · Pull Request &amp; Merge Request review · Bitbucket / GitHub reviewer tool · local / self-hosted / private deployment</sub>

**English** · [简体中文](README.zh-CN.md) · [Website](https://huhamhire.github.io/code-meeseeks/)

</div>

---

Code Meeseeks (internal codename `meebox`) is a **desktop graphical interface (GUI)** for the command-line tool [pr-agent](https://docs.pr-agent.ai/): it packages AI-assisted code review into a desktop client — it fetches the PRs (Pull Requests / Merge Requests) awaiting your review, runs pr-agent locally to generate review comments, and lets the reviewer **confirm / edit each one** before publishing it back to the code hosting platform (GitHub / Bitbucket / GitLab).

Core design stance:

- **The human decides** — every comment must be confirmed / edited by the reviewer before it reaches the remote; the AI only drafts.
- **Rules stay local** — the reviewer configures their own check rules, style preferences, and LLM provider.
- **Data stays local** — repository mirrors, PR metadata, and comment drafts all live in a local working directory; friendly to corporate intranets.

> Inspired by Mr. Meeseeks from _Rick and Morty_: summoned on demand, does exactly one thing, and vanishes once it's done.

## Where it fits

- ✅ Engineers / Tech Leads who take on code-review duties
- ✅ Those who want AI to speed up review while keeping the final decision, rather than handing judgment entirely to a bot
- ✅ Teams running self-hosted Bitbucket / GitLab inside a corporate intranet

## Where it doesn't

- ❌ Not a review bot that runs automatically in CI (that role belongs to pr-agent itself)
- ❌ Not a collaborative team review platform (no server, no multi-user sync)
- ❌ Not a replacement for the code platform's native review interface

---

## Core features

#### 🌍 Multi-platform access

- **Unified access to GitHub / Bitbucket / GitLab** — for self-hosted GitHub Enterprise / GitLab Self-Managed, just enter the instance URL; capabilities adapt per platform (e.g. graceful degradation of GitLab CE/EE approvals).
- **Local-first, works out of the box** — repository mirrors, PR metadata, and comment drafts all live in a local working directory, friendly to corporate intranets; pr-agent is embedded in the installer, with zero external dependencies.
- **HTTP proxy** — LLM calls, code platforms, and git fetches all go through an HTTP proxy, with local addresses connecting directly.

#### 📥 PR discovery and browsing

- **Automatic discovery** — polls for PRs awaiting review, categorized ("to review / created by me", etc.) and grouped by repository, with status filtering and search.
- **Unread and mention markers** — new assignments / new commits / @-mentions / replies are marked unread, with mentions counted separately.
- **History and open-on-demand** — browse merged / closed PRs, or open any PR directly by URL (including adding comments and re-running review).

#### 🔍 Local diff reading

- **Side-by-side / inline diff** — an editor-grade reading experience: file tree (with merge-conflict markers), view by change range / single commit, scrollbar overview ruler, blame, and cross-file code search.
- **Inline comments** — comment on both added and removed lines; selected code can be referenced as context in a question.

#### 🤖 AI / Agentic review

- **Command-driven pr-agent** — drive it conversationally with `/describe`, `/review`, `/improve`, `/ask`; results are structured into actionable review findings.
- **Re-review loop** — raise an `/ask` re-review on a review suggestion, and per the verdict (supersede / keep / withdraw) the original comment is automatically superseded or closed.
- **Agentic orchestration** — natural-language-driven planning + multi-tool orchestration + long-term Memory, with an observable process (a think → tool → think timeline); you can add input mid-run and stop at any time, turning review into collaboration with accumulating context.
- **AutoPilot pre-review** — automatically pre-runs review on new PRs pending your review, so drafts are ready for confirmation the moment you open the app; write actions are gated by per-item authorization + red-line checks (read-only tools only by default).

#### ✍️ Review loop and collaboration

- **Confirm → publish** — turn findings into drafts, edit inline, and publish to the remote one by one or in bulk; the remote mergeable state is visible, and you can merge with one click when conditions are met (or via `/merge`).
- **Comment interaction** — reply to / edit / delete your own comments; supports emoji reactions, @-mention completion, image attachments (paste / pick to upload), and `:shortcode:` emoji rendering (as each platform allows).
- **Activity timeline** — comments / commit updates / review verdicts are merged into a single timeline (GitHub / Bitbucket).
- **Notifications** — categorized system notifications for new PRs, comment replies, and @-mentions, only for pending PRs and never for already-decided items; click to jump straight to the PR or code line, with a macOS dock badge showing how many comments await your response.

#### ⚙️ Models and rules

- **Multiple LLM providers** — OpenAI / openai-compatible / DeepSeek / Anthropic / Tongyi Qianwen / Volcengine Ark, and more (local Ollama connects via the openai-compatible `/v1` endpoint); you can also call third-party models through an authorized local CLI tool (e.g. claude / codex).
- **Personalized rules** — each reviewer maintains their own rules directory (markdown + frontmatter, organized recursively into subdirectories), matched by project / repository / target branch; matched rules are injected into the review in Ruleset sections, ordered by `priority`.
- **Tunable runtime parameters** — review task concurrency, input context length, and agent strategy (auto follow-up toggle, number of follow-ups / code suggestions) are all adjustable on the settings page.

#### 🔌 External integration and CLI

- **Integrable by external agents** — PR review capabilities are exposed via a local HTTP interface + a cross-platform CLI, letting local agentic tools (e.g. claude / codex), scripts, and CI fold PR discovery / browsing / review-agent operations into automated workflows.
- **Local API service** — optionally enable a local API that exposes PR discovery / browsing / diff / review-agent operations / review write actions over a language-agnostic HTTP contract; reachable only from localhost by default, with mandatory access-token auth, and no merge or mutating tools exposed.
- **Cross-platform CLI `meebox`** — Windows / macOS / Linux clients ship with each release to browse PRs, drive the review agent, and perform review write actions (approve / needswork / comment) via the local API; `meebox login` stores credentials once so you never pass them again, and **the archive is itself an agent skill directory that drops straight into an agent's skills folder**. See **[CLI tool](docs/guide/06-cli.md)** for usage.

#### 🎨 Interface and experience

- **Themes and appearance** — dark / light / follow system, several editor color themes, and a custom monospace font and size.
- **Command palette** — invoke with `Ctrl/Cmd+Shift+P` to quickly run common actions and centralize scattered features.
- **Multilingual UI** — English / 简体中文 / 日本語 / Deutsch, with the AI's reply language following the UI language.
- **Frameless window** — a custom-drawn title bar (VS Code style) showing the brand name and current PR title.

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/images/screenshot.dark.png" />
  <img src="assets/images/screenshot.light.png" alt="Code Meeseeks UI preview" width="900" />
</picture>

</div>

---

## Installation

Download the installer for your platform from [Releases](../../releases):

| Platform    | Artifact                                             | Status      |
| ----------- | ---------------------------------------------------- | ----------- |
| Windows x64 | `code-meeseeks-<version>-win-x64.exe` (NSIS installer) | ✅ Available |
| macOS arm64 | `code-meeseeks-<version>-mac-arm64.dmg`              | ✅ Available |

pr-agent is embedded in the installer, so it works right after installation with no extra environment setup.

> **First launch on macOS**: the installer is ad-hoc signed and not Apple-notarized, so Gatekeeper will block the app from an unknown developer. On first use, right-click the app and choose "Open", or go to "System Settings → Privacy & Security" and click "Open Anyway"; after confirming once it launches normally.
>
> Why it isn't notarized: this project is **free and open-source software** without a paid Apple Developer account (which notarization requires). The source is fully public, auditable, and buildable yourself; ad-hoc signing does not affect functionality or security.

---

## Quick start

1. **Configure the connection** — enter the code platform URL + credentials on the settings page.
2. **Configure the LLM** — pick a provider and fill in the API key / base_url / model name.
3. **Discover PRs** — the app automatically polls for PRs awaiting your review, grouped by repository in the left list.
4. **Read + review** — select a PR to view the diff, and click the auto-review button to have the AI generate findings; you can also enter fixed commands (e.g. `/describe`) or a natural-language request in the dialog box.
5. **Confirm + publish** — turn findings into drafts, edit the wording, and publish to the remote one by one or in bulk.

Configuration lives in `~/.code-meeseeks/config.yaml`; repository mirrors default to `~/.code-meeseeks/repos/` and can be moved elsewhere on the settings page.

> **HTTP proxy** (optional, for intranet users): under "Network proxy" on the settings page, enter the HTTP proxy host / port / Basic Auth; once enabled, LLM calls, code platforms, and git fetches all go through the proxy, with local addresses connecting directly (includes a "Test connection" button).
>
> **Git fetches over SSH** do not use this setting; configure `ProxyCommand` for the relevant host in `~/.ssh/config` yourself.

For details on each step (installation and first use, PAT permissions and clone protocols, LLM model selection, HTTP proxy) see the **[User guide](docs/guide/README.md)**.

---

## Platform support

| Platform                       | Status                                                          |
| ------------------------------ | --------------------------------------------------------------- |
| GitHub                         | ✅ Verified (github.com + GitHub Enterprise Server, REST API v3) |
| Bitbucket Server / Data Center | ✅ Supported (REST API v1, >= 7.0)                              |
| GitLab                         | ✅ Supported (gitlab.com + Self-Managed, CE / EE, REST API v4, >= 13.8, 15.6+ recommended) |

---

## Model support

Review capabilities connect through pr-agent (backed by litellm), so it is **in principle compatible with any OpenAI-compatible / litellm-supported model provider** (pick the provider on the settings page and fill in the API key, base_url, and model name). The table below lists the built-in provider options on the settings page and their tested status:

| Provider            | Notes                                       | Status       |
| ------------------- | ------------------------------------------- | ------------ |
| `openai`            | OpenAI (GPT family)                         | ✅ Verified  |
| `anthropic`         | Anthropic (Claude family)                   | ✅ Verified  |
| `deepseek`          | DeepSeek                                    | ✅ Verified  |
| `dashscope`         | Alibaba Bailian (DashScope, Tongyi Qianwen) | ✅ Verified  |
| `volcengine-ark`    | Volcengine Ark (Doubao)                     | ✅ Verified  |
| `openai-compatible` | OpenAI-protocol compatible (vLLM / gateway / self-hosted / local Ollama `/v1`) | ✅ Verified  |
| `cli`               | Call a third-party model via a local CLI tool | ✅ Verified  |

> **About local CLI mode**: this mode does not call a model API directly; instead it hands the review request to a local command-line tool that you **install and authorize yourself**, which in turn calls the third-party model behind it. You must first install and log in to the corresponding CLI tool on your machine; the app itself does not manage its credentials or billing.

> 💸 **Cost note**: Agentic review and AutoPilot pre-review chain multiple model calls per PR (describe, review, follow-ups when needed, summarize), so token consumption is noticeably higher than a single manual review. Whether you use a pay-as-you-go API or a subscription / local CLI account with a quota cap, watch your usage pace and assess the cost yourself; per-step token usage is shown step by step on the review timeline for easy monitoring.

---

## Tech stack

- **Desktop shell**: Electron + Vite (electron-vite)
- **Renderer**: React + TypeScript (strict)
- **Editor**: Monaco (side-by-side / inline diff)
- **Engineering**: npm workspaces + Nx monorepo
- **pr-agent integration**: an embedded Python-runtime subprocess (falls back to the system pr-agent CLI when absent)

> 📚 **Further reading**
>
> - Delivered capabilities, roadmap, and open items: **[Roadmap](docs/ROADMAP.md)**
> - Detailed architecture and per-module design: **[Module docs](docs/arch/README.md)**

---

## Development

For environment setup, running in dev, and building / packaging, see the **[Development guide](docs/development/README.md)**.

---

## Privacy and data

- **Local-first**: apart from calling the LLM API and accessing the configured Git platform, no data is reported to any third party.
- **Working directory**: app data lives at `~/.code-meeseeks/`, with a configurable repository mirror directory.
- During review, pr-agent sends only the PR diff + the reviewer's rules to the reviewer's own configured LLM; wire up a local model (e.g. local Ollama) and nothing ever leaves your machine.

---

## Acknowledgements

Built on top of [PR-Agent](https://github.com/The-PR-Agent/pr-agent) — the open-source version Qodo contributes to the community (site: [docs.pr-agent.ai](https://docs.pr-agent.ai/)). It is bundled as a third-party dependency, distributed under its own license, and **outside the renaming / modification scope of this project**.

## License

This project is licensed under the [Apache License 2.0](LICENSE).

The distributed installers bundle third-party components (PR-Agent, Electron, etc.), each distributed under its own license, aggregated in [NOTICE](NOTICE); the full third-party license set (THIRD-PARTY-NOTICES) is generated automatically at build time and bundled into the installer (in the app's resources directory).

## Trademarks and disclaimer

This project is an unofficial, independent open-source tool, **not affiliated with, authorized by, or endorsed by _Rick and Morty_ or its rights holders in any way**. Names, characters, and related elements such as "Rick and Morty" and "Mr. Meeseeks" are the copyrights and trademarks of their respective owners (Adult Swim / Warner Bros. Discovery, etc.). This project's name and icon are borrowed purely as an homage and assert no related rights; should the rights holders object, we will adjust accordingly.

---

<div align="center">

Made on 🌏 with ♥️.

</div>
