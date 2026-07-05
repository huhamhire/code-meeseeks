# Command palette

## Responsibilities & boundaries

A VS Code-style command palette embedded in the title bar: a unified input entry for quick actions, and the discoverable, keyboard-reachable home for features that have "no direct interaction entry".

Owns: registering commands and grouping them by domain, searching by the current UI language, two-level selection interaction, and immediate command execution. Does not own: the implementation behind each command (it reuses existing settings / IPC capabilities rather than starting a new one), or slash-command parsing (chat has its own; see [Review workflow](../01-platform/03-review-workflow.md), which may later merge into the same registry).

## Functional design

The design of "what a command does, and how it is organized / gated / executed"; for the concrete command list see "[Commands & shortcuts](#commands--shortcuts)".

- **Registry + per-domain files**: command implementations are split by domain into their own files, and one registry aggregates all domains; the upper layer knows only the single entry "build the top-level commands". Adding a domain = add a domain file + register it in the registry, without touching the upper or interaction layers.
- **Domain and command organization**: commands are grouped by domain, and **domains are fixed in dictionary order of their English names**; each top-level command carries a domain `category`, shown as a prefix of the command name and included in search (searching the domain name filters out all commands in that domain). The three current domains are **PR / Review / Settings**.
- **Unified gating (`when`)**: a command can declare a `when()` predicate, and the registry filters uniformly by it — return false and it does not appear, so domains no longer each write their own `if` (e.g. "Run auto review"'s `when` is "there is a selected PR"; if a platform lacks a discovery category, its command simply is not generated — data-driven gating). Transient runtime guards (such as **re-entry protection** when the same PR is already running) live inside `run`, decided live on click (more reliable than visibility), going through the same `agent:run` channel as ChatPane's one-click review, with run state reflected via events / store.
- **Immediate effect reuses existing primitives**: command execution always reuses the same "take effect immediately + write to disk + sync front-end config" pipeline as the settings page (UI language goes through i18n runtime switch + persistence, theme via the appearance store derivation, model / proxy via the corresponding config-write IPC), **not a second implementation**, guaranteeing behavior identical to the settings page. Deep-link commands (open About / the model section) open the settings panel and locate the given section.
- **Second-level options are lazily evaluated**: options are computed only when entering a container command, reading the current config to mark the "active item" (checked). The model list has a fixed "Add model…" entry at the end (the sole entry when there are no profiles), which opens the settings model section to create one.
- **Free-text input commands**: a command can declare `input` (placeholder hint + `run(text)`); after entering the second level the input box switches to accepting arbitrary text and submitting on Enter (mutually exclusive with `options` / a top-level `run`). "PR: Open URL" has landed — it parses the link by its path shape (ignoring host / query / suffix); if it already exists locally (active / archived) it locates it directly, otherwise it authenticates and fetches it remotely, stores it in the archive cold storage (expiring on the archive lifecycle), and opens it; no active connection / invalid link / no permission is fed back via toast with an error code. The backend contract is IPC `prs:openByUrl` and [State storage](../99-core/01-state-storage.md).

## Commands & shortcuts

The currently implemented commands, their functions, and window-level shortcuts (macOS uses symbols, other platforms use text; no shortcut is shown as —).

| Domain | Command | Function | macOS | Windows / Linux |
| --- | --- | --- | --- | --- |
| — | Open command palette | Summon and focus the title-bar command input box | <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>P</kbd> | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> |
| PR | View "Review Requested / Created / Assigned / Mentioned" | Switch to the corresponding discovery category (per platform capability, one first-level command each) | — | — |
| PR | View closed | Switch to the archived (closed) scope to browse retired PRs | <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>H</kbd> | <kbd>Ctrl</kbd>+<kbd>H</kbd> |
| PR | Category filter | Second level: filter by status (pending / all / conflicting / mergeable, etc., gated per platform) | — | — |
| PR | Open URL | Free-text second level: paste / type a PR link on the current platform to open it (including others' / retired PRs) | <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>U</kbd> | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>U</kbd> |
| PR | Toggle PR list | Collapse / expand the left PR list (sidebar) | <kbd>⌘</kbd>+<kbd>B</kbd> | <kbd>Ctrl</kbd>+<kbd>B</kbd> |
| Review | Run auto review | Run auto review on the currently selected PR (requires a selected PR; re-entry protection) | <kbd>F5</kbd> | <kbd>F5</kbd> |
| Review | Toggle AutoPilot | Turn AutoPilot pre-review on / off | — | — |
| Review | Toggle chat panel | Collapse / expand the right chat panel (ChatPane) | <kbd>⌘</kbd>+<kbd>J</kbd> | <kbd>Ctrl</kbd>+<kbd>J</kbd> |
| Settings | Switch display language | Second level: pick the UI language (immediate switch + persistence) | — | — |
| Settings | Switch theme | Second level: pick the editor color theme (including "Follow system") | — | — |
| Settings | Switch model | Second level: pick an LLM profile ("Add model…" entry at the end) | — | — |
| Settings | Toggle proxy | Turn the network proxy on / off | — | — |
| Settings | Open settings | Open the settings panel | — | — |
| Settings | Open About | Open the settings panel's "About" section | — | — |
| Settings | Open DevTools | Open the Electron DevTools (detached window) | <kbd>⌥</kbd>+<kbd>⌘</kbd>+<kbd>I</kbd> | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd> |

## Interaction conventions

- **Trigger and position**: the input box is docked in the middle of the title bar (an absolutely centered overlay that does not take flow or squeeze the sides), opened and focused by shortcut (a window-level render-layer listener). The PR title stays in its place on the left (avoiding the Windows window controls at the top-right); when a long title approaches the command box the right edge fades out and sinks under the overlay (the input box's opaque background covers it), and short titles are unaffected.
- **Two-level navigation**: the top level is the command list; selecting a "container" command (switch language / theme / model) or a "free-text" command (open URL) enters the second level in place — an option list or plain input. **At most two levels**; the second level shows a prefix hint on the left (`prefixLabel`, e.g. "URL ›", otherwise falling back to the command name), and **an empty query with `Backspace` returns to the previous level**, while `Esc` exits the whole palette. Leaf commands (open settings / About / DevTools, toggle proxy) execute directly.
- **Bilingual display + Chinese-English search**: command wording is localized to the UI language; **in non-English UIs** a command carries an **English second line** (aligning with VS Code's display-language behavior), while an English UI shows a single line. The search haystack **always contains both Chinese and English** — English search is always supported (even when the second line is not shown). After a language switch the command list is rebuilt in the new language (keyed by language, rather than relying on a change of the `t` reference).
- **Shortcuts**: common commands are given **window-level** shortcuts (not the system-level `globalShortcut` — that fires even when the app is unfocused, which is not wanted; cross-platform, mac `⌘`/`⌥` vs. `Ctrl`/`Shift` elsewhere). Key selection **prioritizes avoiding conflicts over mnemonics**: steer clear of Tencent-suite screenshots (`…+A`), reload, `Cmd+Enter`, and other conflicts, preferring none over a forced fit (e.g. AutoPilot has no key for now). Commands with keys are shown in the palette in VS Code's "one key, one box" style (the command declares a key-token array, and platform-specific formatting renders it). See the key list in the table above.
- **Coexistence in the title bar**: the command-palette overlay shares the custom-drawn title bar with the PR title, brand name, and platform window controls (mac traffic lights / Windows overlay); newly added title-bar elements must obey the drag-region / no-drag split and must not be placed in the top-right window-control cover area.

## Data / interface contract

- **Command context (CommandContext)**: the current config + a hook to sync front-end config + "open the settings panel (with an optional initial section)" + the translation function for the current language. Every domain's command builder receives it.
- **Top-level command (RootCommand)**: `id` / localized `title` / domain `category`; one of two — a leaf's `run`, or a container's `options` (lazily returns second-level options + the input placeholder hint shown after entering).
- **Second-level option (CommandOption)**: `id` / `title` / whether `active` (the active item is checked) / `run`.
- **Settings-panel deep link**: the settings panel accepts an "initial section" argument; the command palette's "open About / add model" locates the section by it.

## Extension & caveats

- **Adding a domain command**: add a domain file exporting that domain's command builder and register it in the registry; fill in the command wording under the `commandPalette` namespace of all four locales (recursive dictionary order).
- **Slash-command merge**: not included for now (planning undecided). In the future, chat slash commands and the command palette could share the same registry (the command model already has room for `when`-style context predicates), avoiding drift between two sets of definitions.
- **Key maintenance**: the in-palette key hints (the table above / the `shortcut` token array) are display only; the actual key matching is decided separately in the window-level listener (see the global shortcuts in [GUI interaction](01-ui-interaction.md)), and the two are maintained independently — keep both in sync when changing a key.
