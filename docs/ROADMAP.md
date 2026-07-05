# Code Meeseeks Roadmap

> Last updated: 2026-07-05

> For user-facing **feature details**, see **[README](../README.md)**.
>
> For each module's **design and implementation details**, see the **[module design docs docs/arch/](arch/README.md)**.

## 1. Delivered capabilities

#### 🌍 Multi-platform integration

- [x] Unified integration with GitHub / Bitbucket / GitLab (including GitHub Enterprise / GitLab Self-Managed, with adaptive degradation per platform capability)
- [x] Local-first: repo copy / PR metadata / drafts stored locally; embedded pr-agent runtime, no Python / Docker install needed
- [x] Outbound HTTP proxy (local addresses auto-direct)

#### 📥 PR discovery and browsing

- [x] Polling auto-discovery + categories (To review / Created by me / Assigned / Mentioned) + repo grouping + status filter + search
- [x] Unread and mention markers (newly assigned / new commits / @-ed / replied to; mention count tallied separately)
- [x] Archived-history browsing + open any PR by URL (including supplementary comments, re-running reviews)

#### 🔍 Local diff reading

- [x] Side-by-side / inline diff, file tree (merge-conflict annotation), by change scope / single commit, overview ruler, blame, cross-file search
- [x] Inline comments (on added and deleted lines alike) + selected code as context reference

#### 🤖 AI / Agentic review

- [x] Command-driven pr-agent (`/describe`·`/review`·`/improve`·`/ask`), with results structured into actionable review findings
- [x] Re-review loop: launch an `/ask` re-review of a finding, auto-handling the original comment per the verdict (supersede / keep / withdraw)
- [x] Agentic autonomous planning + multi-tool orchestration + long-term Memory + observable process, with mid-run input and stop-anytime
- [x] AutoPilot pre-review: auto pre-runs on new to-review·pending PRs, with admission control + per-item authorization + red-line checks (read-only tools by default)
- [x] CLI-mode `/ask` repo-file access: a one-off worktree takes full context + cleans the repo's own agent-instruction files before landing in cwd to prevent injection (see [agent design](arch/02-agent/01-agent.md))

#### ✍️ Review loop and collaboration

- [x] Findings → draft pool → inline editing → single / batch publish; remote mergeable state visualized + one-click merge (also `/merge`)
- [x] Comment interaction: reply / edit / delete + emoji reactions + @-mention completion + image attachments + `:shortcode:` emoji rendering (per platform capability)
- [x] Activity timeline: comments / commit updates / review decisions merged into one (GitHub / Bitbucket)
- [x] Notifications: categorized system notifications for new PR / comment reply / @-mention (pending PRs only) + click-through to PR / code line + macOS dock badge + macOS permission guidance

#### ⚙️ Models and rules

- [x] Multiple LLM providers (OpenAI / openai-compatible / DeepSeek / Anthropic / Tongyi Qianwen / Volcano Ark, etc.; local CLI claude·codex) + token-usage collection
- [x] Personalized rules directory (markdown + frontmatter, recursive sub-directories; multiple matches injected by Ruleset section, sorted by `priority`)
- [x] Adjustable runtime parameters: review-task concurrency, input context length, Agent strategy (auto follow-up toggle, code-suggestion count)

#### 🔌 External integration and CLI

- [x] Local API (local-only reachable + token auth) exposing PR discovery / browsing / diff / review Agent / review write actions, for external agent · script · CI integration
- [x] Cross-platform CLI `meebox` (Windows / macOS / Linux): browse PRs + drive the review Agent + review write actions (approve / needswork / comment); the archive is itself an agent skill directory

#### 🎨 Interface and experience

- [x] Themes and appearance: dark / light / follow system + several editor color themes + custom monospace font and size
- [x] Command palette (`Ctrl/Cmd+Shift+P`) centralizing scattered features + global shortcuts
- [x] Four-language UI (Simplified Chinese / English / 日本語 / Deutsch), with the AI reply language following the UI language
- [x] Frameless custom title bar + first-launch config wizard + visual CRUD on the settings page

#### 📦 Engineering and release

- [x] Monorepo multi-package (npm + Nx) + Electron + typed IPC + CI (lint / typecheck / test / build)
- [x] Desktop installers Windows x64 + macOS arm64; CI auto-builds and publishes a GitHub Release on `v*` tags (no Linux for now)
- [x] Brand website (VitePress, English default + Chinese, deployed independently to GitHub Pages, decoupled from the release pipeline) + bilingual external docs (README / user guide: English canonical + Chinese mirror)
- [x] Open-source release (Apache-2.0 + NOTICE)

---

## 2. Ongoing evolution

Open-ended continuous phases, with no single Done-when.

### In progress / backlog ⏭️

- [ ] **Observability expansion**: rule hit rate, model comparison (token usage already done).

---

## 3. Risks and open items

| Risk / topic | Response |
| --- | --- |
| Plaintext credentials (config.yaml) | Tighten file permissions + doc warnings + a reserved `SecretStore` abstraction (no keytar-upgrade plan for now, see [config and secrets](arch/99-core/02-config-and-secrets.md)) |
| LLM call cost | Token-usage tracking done; rule layer can control max_tokens / model tiering |
