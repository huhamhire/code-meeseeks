# Changelog

**English** · [简体中文](CHANGELOG.zh-CN.md)

All notable changes to this project are recorded here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### ✨ Added

- Binary files in the diff (images, office documents, PDFs, …) now show their Git LFS status — a "Git LFS · &lt;size&gt;" tag for LFS-managed files, or a "⚠ Not LFS" tag for files stored inline in git.
- Comments can now be anchored to a whole file (not only a single line) where the platform supports it (Bitbucket / GitHub): a "comment on file" entry in the diff, and existing file-level comments now display correctly instead of being shown as generic PR comments.
- Reviews now pick up the reviewed repository's own guidance file (`AGENTS.md`) as project context, so the review, description, and suggestions follow the project's stated conventions.
- Replying to a comment now creates a **reply draft** instead of posting immediately — consistent with adding a new inline comment. The reply is persisted (so an unsubmitted reply survives switching PRs/files/tabs), shown below its parent comment on every surface (activity timeline + inline diff), and published together with your other drafts via "Publish comments".

## [0.11.0] - 2026-07-07

> Highlights of this release:
>
> - **Richer `@mention`**: autocomplete now searches users beyond the PR's participants on the code platform (GitHub / Bitbucket / GitLab), so you can mention anyone without knowing their exact username — and mentioning behaves consistently across every comment editor, including inline diff comments and review drafts.
> - **Review engine updated**: the embedded pr-agent moves to 0.39.0, picking up upstream model-provider routing improvements and fixes.
> - **Consistent timestamps**: displayed times now use a fixed, locale-independent 24-hour `yyyy-mm-dd HH:mm:ss` format.
>
> The rest of the release is a batch of review-experience fixes (security-result wording, single-line file diffs, inline-comment width, token-rotation auth, and more).

### ✨ Added

- `@mention` autocomplete can now find users beyond this PR's participants: after the local suggestions, it searches matching users on the code platform (GitHub / Bitbucket / GitLab), so you can mention someone without knowing their exact username. It works consistently in every comment editor — the activity composer, replies (including inline diff comment replies), and review drafts.

### ♻️ Changed

- Updated the embedded review engine (pr-agent) to 0.39.0, picking up upstream model-provider routing improvements and fixes.
- Displayed timestamps now use a consistent, locale-independent format — 24-hour `yyyy-mm-dd HH:mm:ss`, with same-day times showing only `HH:mm:ss` — instead of following the OS locale (so they no longer differ from the app's language or between machines).

### 🔧 Fixed

- Inline review-draft comments now offer `@mention` participant autocomplete, matching the activity and reply composers.
- `@mentions` of a Bitbucket username containing special characters (e.g. a dot) are now inserted in the correctly quoted form, so the mention resolves and notifies the user.
- The review "Security" result now reads unambiguously when there are no concerns (a consistent "no security concerns") instead of a terse "No" that could be mistaken for a warning.
- Reviews of single-line file changes (e.g. a `VERSION` or hash file) no longer misread the change as the file containing both the old and new value.
- Inline comments no longer render at the wrong width (spilling past the editor) when a commented file is opened from the file tree — a manual window resize is no longer needed.
- The close button on the enlarged comment-image preview no longer sits beneath the window controls, and its icon is centered.
- Fetching upstream code no longer fails with an authentication error after a code-platform access token is changed (which previously required clearing the repo cache to recover).
- The default AI-suggestion draft layout again wraps its linked label and model name in brackets (the intended `[label (model)]` form).

## [0.10.0] - 2026-07-05

> Highlights of this release:
>
> - **Brand website launched**: a VitePress-based project website with a landing page / download page / FAQ and hosted bilingual user docs, auto-deployed via GitHub Pages.
> - **Project internationalization**: the README and user docs are now fully bilingual (English default + Chinese).
> - **Customizable code-suggestion output**: steer how AI suggestions are written and lay out the review-draft comment they produce (Settings → Agent → Strategy).
>
> Beyond the external presentation, the desktop app gains customizable code-suggestion output; the rest of the desktop app and CLI behavior is largely unchanged from 0.9.0, aside from a minor startup fix.

### ✨ Added

- **Brand website**: the user-facing project website is now live (<https://huhamhire.github.io/code-meeseeks/>).
  - Landing page: one-line positioning + light/dark-adaptive product screenshots + core features + a model-ecosystem showcase + a download entry linking to Releases.
  - Download page: automatically recommends the matching installer for the visitor's OS, with GUI and CLI in separate columns; the CLI offers one-line install scripts for macOS / Linux; download info is fetched from the latest Release at runtime, with a build-time static fallback to withstand API rate-limiting.
  - FAQ on its own page.
  - Hosted user docs: the website builds and renders directly from the repo's user docs, bilingual and kept in sync with them, and site search supports a Chinese interface.
  - Deploy decoupled from releases: the website deploys to GitHub Pages via an independent pipeline, without occupying the app / CLI release flow.
- **Project documentation internationalization**: external docs are now fully bilingual (English as default / fallback, Chinese as the mirror).
  - The README is split into English (default) and Chinese, switchable from the top of each.
  - User docs are bilingual — English is canonical, Chinese is the mirror, and the website renders each by language.
- **Customizable code-suggestion output** (Settings → Agent → Strategy, both edited in an inline modal):
  - _Suggestion spec_ (`code_suggestion_spec`): free-text guidance injected into `/improve`, `/review`, `/ask` to shape each suggestion's structure (e.g. Problem / Analysis / Suggestion) — a soft constraint the model generally follows.
  - _Suggestion layout_ (`code_suggestion_layout`): a deterministic markdown template for the review-draft comment, with `<TITLE>` / `<SUGGESTIONS>` / `<HOME>` / `<PR>` / `<MODEL>` placeholders. Empty uses a default layout — a linked "AI suggestion" label + model name above the suggestion body (the default draft-comment prefix thus changes from the previous plain `[AI suggestion]`).

### 🔧 Fixed

- Startup now pings only the active connection instead of every configured one: a non-active connection's identity has no UI consumer, so pinging it only added startup network requests and, for an unreachable connection, a recurring warning on each launch. Switching the active connection still refreshes its identity on demand.

## [0.9.0] - 2026-07-02

> Highlights of this release:
>
> - **External integration and CLI**: open a local API to expose PR browsing and review-Agent operations to external integrations, plus a cross-platform command-line tool `meebox`

### ✨ Added

- **External integration · local API service**: Settings gains an "Integration" section where you can start a local API service that exposes PR browsing and review-Agent operations as endpoints for external agents / tools / scripts.
  - Off by default; enabling it enforces access-token authentication, with one-click token generate / show / copy / regenerate.
  - Custom listen address: reachable only from the local machine by default, optionally opened to the LAN (with a security warning when opened).
  - Exposes browsing (current identity / PR list / detail / diff / activity / commits / reviewers), the review Agent (status / history / auto-review / instructions / conversation / interrupt), and review write actions (approve / needs-work / comment); does not expose merge or change-type Agent tools (publish, etc.).
- **External integration · command-line tool `meebox`**: a cross-platform Windows / macOS / Linux command-line client shipped with the release that browses PRs, operates the review Agent, and performs review write actions (approve / needswork / comment) through the local API service — convenient for scripts and external agents. The PR list is compact and paginated; PR-scoped commands use `--pr <id>`; connection info must be provided explicitly (flag / environment variable / cli.yaml) and does not read the GUI's main config.
- **Unread dots on PR-list discovery categories**: when a discovery category (To review / Created by me, etc.) has new pending PRs, an unread dot is added after that category's label so you can see at a glance which category has new activity; the dot is always based on active PRs, correctly reflecting active-category unreads even while in the "Closed" view.
- **Notifications for PRs I created**: three new system notifications for your own PRs — a new comment from someone else, a reviewer marking "needs work", and a merge conflict; the Notifications section provides independent toggles, on by default.
- **Command echo bubbles**: when you issue `/review`, `/describe`, `/improve`, `/ask`, etc. directly in the review-Agent panel, the command is instantly echoed as a user bubble above its result card, matching conversational habit; subtasks dispatched by orchestration / AutoPilot are not echoed, avoiding duplication with the orchestration conversation's user messages.
- **Launch the review Agent per commit**: after switching the change scope to a specific commit in the Diff view, `/describe`, `/review`, `/improve`, `/ask` (including natural-language questions) typed directly in the review-Agent panel are automatically scoped to that commit's own changes (`parent..sha`) rather than the whole PR; the input bar marks the current commit with a scope chip, whose selected state derives from the view selection and can be temporarily disabled by clicking (not removed; switching to another commit auto-resets), consistent with the Diff-selection chip interaction. Only one scope is in effect at a time: when Diff lines are selected the selection takes precedence and the commit scope is suspended, restored automatically once the selection is cleared. Both running and completed review-result cards show the scoped commit's range badge. One-click auto-review still applies to the whole PR.

### ♻️ Changed

- The review Agent's `/ask` (local agentic-CLI provider) injects code-retrieval guidance: it steers toward read-only searches to locate symbols / read only the needed line ranges instead of reading whole files and scanning the whole repo, lowering exploration rounds and token consumption while preserving the depth of reading real files.
- The "follow-up count" cap now also constrains the free-conversation Agent's (conversation-as-delegation) automatic `/ask`: previously this cap applied only to the review micro-flow's conditional follow-ups, while the free planning loop was bounded only by "Agent max steps" and could `/ask` many times in a row (each a costly agentic exploration); now `/ask` in free conversation is likewise capped by "follow-up count" (always in effect, independent of the "auto follow-up" toggle), preventing runaway exploration cost.
- The status bar no longer routinely shows the pr-agent version (reducing steady-state noise), keeping only the warning when it is unavailable; the version now appears in the runtime-environment info on the Settings "About" page.
- The "pending" filter under the "Created by me" category now includes PRs with merge conflicts: from the author's perspective a conflicted PR needs their follow-up to resolve (even if the review has passed), so it counts as pending.
- The PR-list status sub-filter becomes width-adaptive pills: no wrap when a row fits, wrapping otherwise and distributing items evenly to fill each row, eliminating the ragged right-side gap after wrapping.
- Internal branches in the review Agent's derived temporary worktree no longer use a fixed branded name, switching to PR-associated `pr-<localId>/head`, `pr-<localId>/base` (layered naming matching platform PR-reference conventions): removes an identifiable fixed behavioral signature from the output while ensuring the internal branch name never leaks into externally published review content.

### 🔧 Fixed

- Fixed PR-list group-header backgrounds and the Windows window's top-right control buttons not following the theme (editor color theme); both now derive their colors from the current theme, with light/dark and theme switches taking effect in real time.
- Fixed the unread-count chip at the title not clearing immediately after opening a PR with an "@me / replied to me" unread count and requiring the next poll to reset: marking as read now optimistically zeroes that count in sync (previously it only cleared the unread dot, missing the count chip).
- Fixed long labels in the Settings left nav (e.g. "Notifications") overflowing and being clipped in German and other locales; long labels now wrap and display in full.

## [0.8.0] - 2026-06-30

> Highlights of this release:
>
> - **Notifications**: system notifications (new PR / comment reply / @mention) + macOS dock badge + permission guidance
> - **Comment experience improvements**: emoji reactions, @-mention completion, image attachments, emoji-code rendering — consistent across comments / replies / inline / drafts
> - **Command palette**: `Ctrl/Cmd+Shift+P` centralizes common actions
> - **Closed-PR browsing and open-by-URL**: view historical PRs, add comments / re-run reviews
> - **Review-rule enhancements**: recursive rule directory, multiple rules injected by `Ruleset` section
> - **2026 theme colors** and **PR-list mention counts**

### ✨ Added

- **Comment experience improvements**: the comment list, replies, inline (code-line) comments, and draft editing keep a consistent authoring and interaction experience.
  - **Emoji reactions**: existing emoji reactions (with counts and your own marks) are shown beneath comments (including inline comments), clickable to add / remove; GitLab / Bitbucket support searching for more emoji, GitHub offers its fixed set — provided per platform capability, hidden automatically where unsupported.
  - **@-mention autocomplete**: typing `@` while writing a comment / reply lets you complete from this PR's participants (comment and commit authors); you can still freely type any username.
  - **Image attachments**: while writing a comment / reply / inline comment / draft you can paste an image or click the image button at the top-right of the input to upload, auto-inserting it into the body (provided per platform capability, entry hidden where unsupported).
  - **Emoji-code rendering**: emoji codes like `:tada:` in comment bodies render to the corresponding emoji per the built-in set (code blocks and unknown codes are preserved as-is).
- **Notifications**: a new "Notifications" settings section lets you enable system notifications and control them by event type — a new PR received, a comment reply received, being @-mentioned in a comment.
  - Windows / macOS pop native system notifications; whether they show respects the OS notification settings, silenced automatically when off.
  - Windows notifications carry the initiator's avatar, a type marker distinguishing PR / comment / reply, and the repository shown.
  - Notifications pop only for "pending" PRs — approved / needs-work PRs no longer disturb.
  - Click a notification to jump straight there: a new PR opens that PR; an inline comment jumps to the corresponding code line in the Diff, a top-level comment opens that PR's conversation tab.
  - For batch activity, at most 5 pop individually, more collapse into one "See more recent activity" prompt that opens the main UI on click, avoiding notification floods.
  - The macOS dock icon shows a badge with the count of comments awaiting your response.
  - macOS notification settings provide an "Open system notification settings" button to grant notification permission at the OS level (macOS does not allow an app to enable it on your behalf).
- **PR-list mention counts**: when unread comments include @-you / replies-to-you, the unread dot before the list-item title upgrades to a count marker showing the number (capped at "10+"), so you can see at a glance how many comments await your response; unread from new assignment / new commits alone still shows a dot.
- **About-page system info**: the Settings "About" page adds the operating system (platform + version) and CPU architecture, plus a "Copy info" button to copy all runtime-environment info at once, handy for attaching your environment when reporting issues.
- **Closed-PR browsing and supplementary review**: a new "Closed" scope switch in the sidebar to view PRs that have exited (merged / closed / no longer need your review); loaded on demand on entry.
  - Merged / still-open PRs can take additional comments and re-run AI review (a merged PR whose source branch was deleted locates diffs by commit); only merge / approval and other change actions are withheld.
  - Closed (declined) PRs are browse-only.
- **Open PR by URL**: the command palette adds "Open URL" (shortcut mac `⌘⇧U` / otherwise `Ctrl+Shift+U`) — paste / type a PR link for the current platform to open it (trailing suffixes ignored), for viewing others' PRs you were not formally requested to review, including merged / closed PRs.
  - A PR already in the list or history is located directly; a new link is authenticated, fetched, and stored in history (cleared on the same lifecycle expiry), prompting on no permission / invalid link.
- **Command palette**: a command input in the title bar (`Ctrl/Cmd+Shift+P`) to quickly run common actions and centralize scattered features.
  - PR commands: view each discovery category (To review / Created by me, etc., per platform capability), view Closed, Open by URL, category filters (pending / all / conflict / mergeable, etc.), toggle the PR list.
  - Review commands: run auto-review, toggle AutoPilot, toggle the conversation panel.
  - Settings commands: switch display language / theme / model, toggle proxy, open Settings / About / DevTools.
  - Commands are categorized by domain prefix (PR / Review / Settings), with two-level selection (e.g. "Switch theme" expands the theme list); non-English UIs append the English name and always support Chinese-and-English search, with matches highlighted.
  - Opens with the last-used command selected by default; press Enter to repeat.
  - Common actions support shortcuts (toggle PR list / conversation panel, run auto-review, DevTools), with the corresponding keys shown in the palette.
- A README file is added to the Agent context directory: it introduces each file's purpose and links to the project home, making the directory easier to understand and maintain in a third-party editor.

### ♻️ Changed

- The default theme (follow system) switches to the 2026 series colors: dark / light use Dark 2026 / Light 2026 respectively, with the launch splash aligned; settings with a custom theme are unaffected.
- Exited (merged / closed / no-longer-need-your-review) PR data moves out of the active directory into separate archive storage, with the archive retention and expiry auto-cleanup policy unchanged.
- The Agent's SOUL (persona definition) file is now managed uniformly by the app: each load auto-aligns to the built-in template and local edits are no longer kept, so the Agent's behavior baseline updates uniformly with each version (AGENTS / MEMORY / USER and rules remain yours, freely editable).
- Review-rule enhancements: the rule directory supports recursive sub-directory organization, auto-loading all rule files; multiple rules matched by the same PR are no longer limited to the first — they are injected into the review by `Ruleset` section (sorted by priority, capped at 20 per run), and the match hint now shows a count with all matched rules previewable.
- The PR-list status sub-filter refines per discovery category: "pending" reflects "not yet reviewed by me", kept only in the "To review" category and, on platforms supporting a "needs work" review state (GitHub / Bitbucket), in categories like "Created by me"; GitLab (binary approval, no "needs work") no longer shows the meaningless "pending" in non-"To review" categories.
- The Agent directory's example rules are now generated only on first initialization; once deleted they are not recreated, making it easy to clear unwanted examples.

### 🔧 Fixed

- Fixed the Agent context directory not being initialized and loading empty after pointing it to a custom or new location; now, whether changed via settings or by directly editing the config, the directory auto-fills the SOUL / AGENTS and other context templates before use.
- Fixed being unable to locate and open a running AI task's PR conversation from the status-bar execution indicator after its PR was auto-moved to "Closed"; it now correctly jumps to the "Closed" category, selects that PR, and opens the conversation.
- Fixed the status-bar "PRs to review" count including PRs like "Created by me" that are not for me to review; it now counts only PRs that need my review and are not yet handled by me.
- Fixed comment replies / @-mentions from others on some platforms (especially Bitbucket) often not popping a notification; comment changes are now reliably tracked for pending (To review / Created by me) PRs, with replies and mentions promptly alerted.
- Fixed clicking a system notification being unable to locate an archived PR (e.g. a running task's PR just moved to "Closed"); it now correctly jumps to the "Closed" category, selects that PR, and opens the corresponding position by type.
- Fixed inline comments needing a switch to another PR and back to refresh when the PR you are viewing (Diff) receives a new comment reply; the currently open comments now refresh immediately once polling detects a reply / mention.

## [0.7.0] - 2026-06-27

> Highlights of this release:
>
> - **Dark / light themes and appearance system**: theme switching, editor color themes, custom monospace font and size
> - **AI review runtime parameters**: review-task concurrency, context length, Agent strategy (auto follow-up / code-suggestion count)
> - **PR-list unread markers**
> - **Agent conversation enhancements**: attached display of selection references, markdown-formatted thinking, `/merge` for direct merge
> - **Faster local agentic-CLI orchestration**
> - **Domain-oriented refactor of the code-platform integration layer** (behavior unchanged)

### ✨ Added

- **Themes and appearance**
  - Dark / light theme switching: choose light, dark, or follow system, with the UI switching instantly and persisting across restarts.
  - Editor color themes: several built-in options (VS Code 2026 / Modern, high-contrast, plus GitHub, Monokai, Dracula, Nord, Solarized, etc.), following the app theme or set separately.
  - Editor font and size: custom monospace font (multiple candidates) and size, applied to the editor and all app monospace text (diff / comments / code blocks) alike.
- **AI review runtime parameters**
  - Review-task concurrency: adjust the number of simultaneous review tasks (1–8) in the Settings "AI" section, effective immediately, no restart.
  - Context length: set the context-length cap for trimming input content (habitual tiers from 32k–1M) in the Settings "AI" section, so long PRs fit fully into the prompt; not in effect for local CLI mode.
  - Agent strategy: a new strategy group in the Settings "Agent" section — "auto follow-up" (when off, the review summarizes directly with no conditional follow-up, saving tokens) and "code-suggestion count" (uniformly constrains the number of code suggestions generated per `/review`·`/improve`·`/ask`, 2–8).
- **PR list**
  - Unread markers: a PR newly entering the review list (newly assigned / your review requested), or with new commits pushed since you last viewed it, or someone @-ing you / replying to you, gets an unread dot on the list item; opening the PR clears it.
- **Agent conversation**
  - Attached display of question references: when asking about code with a Diff selection, the referenced code is shown collapsed beneath the message bubble (comment-suggestion references reuse the locating badge on the re-review card).
  - Preformatted thinking: thinking / judgment content renders as markdown (code blocks / lists / line breaks).
  - New `/merge` command: a PR meeting the merge conditions can be merged directly in the conversation, with a confirmation prompt before triggering.

### ♻️ Changed

- The Agent's own orchestration steps (routing / follow-up judgment / review summary) respond faster in local agentic-CLI mode: each step no longer loads the unused API call stack, lowering the fixed startup latency per response, making conversation and auto-review more responsive overall.
- The settings panel switches to a left-right sectioned layout: section nav on the left (General / Connection / AI / About), config items grouped by section on the right, replacing the previous single-column layout; the section structure reserves room for later expansion (theme, editor style, context window, etc.).
- **Domain-driven refactor of the code-platform integration layer** (behavior unchanged): laying the groundwork for later platform integration and maintenance.
  - Split into independent services by the four domains of connection, PR operations, comments, and users & media, with clearer responsibilities, easier to maintain and test per domain.
  - Each platform's connection and proxy config is unified into the connection layer, and a new code platform can be integrated step by step per domain.
  - Platform-connection status hints (e.g. version-unsupported reasons) are now localized to the UI language.

### 🔧 Fixed

- When a side-by-side diff auto-degrades to a unified layout in a narrow window, the scrollbar-overview ruler's deletion marks were lost, leaving only additions in green; it now correctly distinguishes red/green per the actual layout.
- Window size and maximized state are now remembered across restarts (previously often lost after resizing or maximizing and closing).
- With scaling enabled on a high-DPI display, the default window size could exceed the screen; it now adapts to the current display's available area and centers.
- Temporary files occasionally left in the local state directory would keep accumulating each run; they are now cleaned up automatically at startup.

## [0.6.0] - 2026-06-23

> Highlights of this release:
>
> - **`/ask` re-review loop**: launch a re-review of review suggestions, auto-superseding / closing the original comment
> - **`/ask` structured sectioned output** and **full-file context**
> - **Mid-run Agent input and the "Plan" panel**
> - **Diff experience enhancements**: selection-reference questions, view by change scope / single commit, conflict-file annotation, deleted-line comments, scrollbar-overview ruler
> - **PR "Activity" timeline**
> - Major domain-driven front/back-end refactor (behavior unchanged) and faster Agent orchestration

### ✨ Added

- **Agent review and conversation**
  - `/ask` re-review loop: launch a "re-review" of `/review`, `/improve` code-comment suggestions (findings), automatically superseding or closing the original comment per the verdict (supersede / keep / withdraw); the auto-review micro-flow can also trigger a re-review from the judge.
  - `/ask` structured sectioned output: free Q&A is presented color-coded in three sections — conclusion / analysis / suggestions, with code-targeted suggestions locatable by line number and adoptable as inline comments.
  - CLI-mode `/ask` takes full-file context: when the local CLI takes over it can read complete repo files to answer, clearing the repo's own agent-instruction files before reading to prevent injection contamination.
  - "Mid-run input" and the "Plan" panel: typing a message during a run queues it instantly and re-orders subsequent actions; the planning Agent maintains a visible todo plan, persisted with the conversation and auto-restored on PR switch / restart.
  - Run cards show the "actual model interaction scale": presenting prompt-cache hits and model interaction rounds, so multi-round token usage accumulated by the local CLI is not misread as over-limit.
- **Diff reading**
  - Reference selected code in a question: after selecting some lines, they are injected into the model as implicit context with the question and can be ignored with one click; deleted lines and unchanged lines can be referenced too.
  - View by "change scope": switch between viewing all changes or a specific commit's changes, clicking a commit renders a read-only diff locally instead of jumping to the browser.
  - File tree annotates conflicting files: a conflicted PR marks the conflicting files with an amber triangle warning icon, locating them without trying to merge file by file.
  - New inline comments / drafts on "deleted lines": in the side-by-side view the base side (deleted / context lines) can also hover "+" to create.
  - Scrollbar-overview ruler: projects add / change / delete and "lines with comments" beside the scrollbar, drag to locate quickly.
- **PR detail and collaboration**
  - The "Comments" tab evolves into an "Activity" timeline (GitHub / Bitbucket): comments, commit updates, and review decisions merge into one timeline, and you can post a summary comment not anchored to a file directly; GitLab keeps a pure comment view.
  - The PR header shows a reviewer avatar stack: reviewer avatars sorted by review status, with a decision corner badge, overflow collapsed into a "+n" dropdown.
  - Detail-tab internationalization and left-right layout: the whole panel renders text per UI language, changed to description on the left / timeline + reviewer list on the right, responsively stacked when narrow.
- Connection / LLM config modal exit interception: closing with uncommitted changes pops a confirmation, avoiding accidental loss of unsaved content.

### ♻️ Changed

- **Major domain-driven front/back-end refactor** (maintainability, behavior unchanged): reorganizes front/back-end code by domain boundaries, clarifying module responsibilities and dependency direction.
  - Front end: components layered by `common` (base UI) / `layout` (app skeleton) / `features` (business domains), with business logic pushed down to its domain and oversized components (ChatPane / SettingsModal / DiffView, etc.) split into "container + domain components + hooks".
  - Back end: extracts an IPC service layer, groups Agent services by domain, decouples the run queue; the Agent engine extracts a pluggable "step" abstraction to unify step recording and usage accumulation, with orchestration prompts externalized to resource files.
  - External interfaces, UI, and interaction behavior are all unchanged.
- **Faster Agent orchestration response** (behavior unchanged to users): conditional follow-ups are dispatched in parallel, follow-up judgment is slimmed to a lightweight route, the orchestration chain uniformly uses low reasoning + capped judgment output, and the global stable system prefix is wired into the Anthropic 1h prompt cache, lowering overall latency and cost.
- Re-review `/ask` supersede / withdraw now silently auto-closes the original finding, the "supersede" verdict promotes the suggestion into an adoptable code-feedback card, and the front end only shows the closed state read-only with a "view re-review" navigation.
- The Agent's "review summary" focuses on the PR's overall conclusion: it consumes only each follow-up's conclusion rather than the full answer detail, outputting a PR-level overall conclusion without duplicating detail.
- The PR commit list / activity timeline filters merged-in others' commits by first-parent, keeping only this PR's own commits; falls back without losing info when the mirror is not ready.
- Review / Diff UI interaction polish (a batch of small improvements): the review-summary and finding cards share styling and line spacing, collapsible cards expand from the whole title row with a transition animation, clicking a re-review reference badge locates and highlights the original card, danger buttons are unified to a saturated red, the settings modal reuses the first-launch wizard's left-right layout, and the "concurrency limit reached" banner is removed, the `/review` "estimate effort" section is hidden, etc.

### 🔧 Fixed

- After the source branch merges the target branch, the changes-page diff mixed in the target branch's existing changes. (#107, thanks @csj2000)
- `/ask`'s structured sectioning / reference context / re-review verdict instructions previously had no effect on the model.
- The re-review "supersede" verdict's improvement suggestion becomes a directly publishable alternative comment, no longer a meta-discussion about the comment.
- Failed / canceled tasks no longer produce meaningless finding cards.
- CLI-mode `/ask` failed entirely when the repo's own agent-instruction files were under version control.
- A local mirror missing the PR head sha (source branch deleted / force-pushed) caused diff / review failure without self-healing.
- Eliminated multiple render jitters and flickers on PR switch / refresh / tab switch.
- Eliminated the Monaco console `Missing requestHandler` noise error.
- The review summary was occasionally truncated / fell back to "unable to parse suggestions".
- Fetching the changed-file list occasionally failed (`ENOENT … diff-base.json`).
- Merging an already-merged / closed PR gave an unfriendly error.
- Filled in the internationalization of hardcoded text like the PR review-status chip and Agent step rows.
- The Settings-page manual "Check for updates" result now syncs to the status bar immediately.
- The PR detail / comments-page body is width-constrained and centered, and the reviewers list sorts stably.

## [0.5.0] - 2026-06-17

> Highlights of this release:
>
> - Delegable **high-level Agent** (conversation-as-Agent + AutoPilot background pre-review)
> - **Frameless window + custom title bar**
> - Polish of heavy-component load jitter, nested comment display, etc.

### ✨ Added

- **High-level Agent (conversation-as-Agent + AutoPilot pre-review)**: a delegable agent introduced into PR review, automatically available with the LLM config, no separate enable toggle.
  - One-click auto-review: runs a "describe → review → (serious issues only) follow-up → summarize" micro-flow for the current PR, giving non-binding advice (suggest approve / request changes / manual review) summarized into a "review summary" card.
  - Conversation-as-delegation: type natural language in the chat box, and the planning Agent calls read-only tools as needed to fulfill the request, politely declining requests unrelated to the PR and stoppable anytime while running.
  - AutoPilot background pre-review: automatically pre-reviews new PRs that are "to review" and "pending", with advice landing in the list badge and the summary landing in the conversation; write operations are gated by per-item authorization + red-line checks (only read-only tools open by default).
  - Review-status visualization: PR-list items show a blue "running" spinner or a review-advice ★ (covering the pure-thinking phase), and AutoPilot-triggered reviews are marked with a robot icon.
  - Parallel multi-question: the planning Agent can dispatch multiple `/ask` in parallel within one round.
  - Review-step token usage visible: each reasoning step shows that step's token usage on the right (not cumulative).
  - Agent context directory: SOUL / AGENTS / MEMORY / USER and rules/ constitute the Agent's persona and knowledge source, landing by default in `~/.code-meeseeks/agent`, idempotently filled with templates on first launch.
- **Frameless window + custom title bar** (VS Code style): removes the native system title bar, renders a 36px title bar in the render layer, carries the dark theme all the way through, hands window-control buttons to the system to keep native behavior, and shows the brand name and current PR title in the title bar.
- The Settings page adds an "About & feedback" entry: three external links — GitHub repo / submit Issue / Releases.

### ♻️ Changed

- **Heavy-component load-jitter convergence**: when switching PRs / files, heavy areas like the diff (Monaco) and conversation content uniformly cover with a delayed loading state and reveal all at once when ready, with zero flicker on cache-hit fast switches.
- Removed the standalone `ollama` provider, unifying local Ollama via `openai-compatible` (with its own compatible endpoint, more standard); old config migrates automatically; `openai-compatible` is marked verified.
- Unified nested comment display (comment tab + inline): replies flatten to the same level at 5 deep, with nesting changed to a flat "left vertical line indent" style.
- describe's "file changes" category is collapsed by default, avoiding overly long output.
- The review summary no longer hard-truncates: `summary_max_chars` is only a soft constraint, generated content is preserved in full.
- A batch of UI details: the review-advice star changes to a four-point sparkle ✦, the unified PR-list status chip has high line height to eliminate drift, and appending a language requirement to the end of the `/ask` question improves answering in the UI language.

### 🔧 Fixed

- Fixed the "changes reverted" misjudgment caused by the PR diff base drifting with the target branch.
- Fixed garbled Chinese logs in the Windows console.
- Fixed a finding-anchor parse error when the file path contains square brackets (e.g. `a/[m-123]/x.ts`).
- Fixed the Anthropic provider's self-built / relay base_url previously having no effect. (#65, thanks @dnvyrn)
- A broken mirror left by an interrupted local-mirror clone/fetch now self-heals by auto-rebuilding.
- Clearing a PR's execution history now also clears the list review-advice ★, and the ★ updates immediately after auto-review completes.
- The PR "commits" count badge excludes commits brought in by merging the target branch into the source branch and merge commits.
- Added the Chinese / Japanese / German translations for the walkthrough file-category headings (Miscellaneous / Formatting / Dependencies).
- Eliminated render jitter triggered by comment-page poll / refresh.

## [0.4.0] - 2026-06-14

> Highlights of this release:
>
> - **GitLab integration** (gitlab.com + Self-Managed, CE / EE)
> - Review-interaction and rendering polish (decline collapse, draft-anchor alignment, in-comment attachment images, GitHub / GitLab comment edit & delete)
> - **Relaxed connection Base URL**
> - **Windows upgrade-install robustness** (per-machine elevation + bypassing the old uninstaller)
>
> ⚠️ **Windows install note**: this release is a **per-machine install** (all users / Program Files); the installer pops UAC elevation on double-click, and the installed app launches with normal privileges. Upgrading from an old version auto-cleans the old install, no manual uninstall needed.

### ✨ Added

- **GitLab integration** (gitlab.com + Self-Managed, CE / EE, REST API v4): MR discovery, diff-comment read / post / edit / delete / reply, merge, clone (PAT / SSH), avatar / attachment proxy; the Settings page and first-launch wizard can add a GitLab connection (Base URL can be left empty to default to gitlab.com).
  - CE / EE approval degradation: detects the edition via `/metadata` — EE supports approve / revoke, CE has no API approval and grays it out in the UI (GitLab approval is binary, no "needs work").

### ♻️ Changed

- **Relaxed connection Base URL**: GitHub Enterprise / GitLab Self-Managed can fill the instance address directly (e.g. `https://ghe.example.com`), with `/api/v3`, `/api/v4` auto-completed; github.com / gitlab.com use the default when left empty.
- After declining a code feedback / improvement suggestion, the card auto-collapses to gray, keeping only the header and anchor row (with an undo entry), reducing the visual footprint of decided items.
- Local CLI-type LLM providers are marked "experimental": noting their dependence on an upstream CLI (claude / codex, etc.) with no stability guarantee.
- The Settings-page connection / LLM preset cards show the corresponding brand-type icon to avoid misconfiguration; danger buttons change to solid saturated red for a stronger warning; the Windows install page no longer expands the blank file-log list, leaving only the progress bar.

### 🔧 Fixed

- Fixed being unable to edit / delete your own comments on GitHub / GitLab.
- Fixed Bitbucket in-comment attachment images not rendering.
- Fixed the anchored line in the code-suggestion draft area not matching the final published location.
- In-comment image proxy failure now degrades to an "open in browser" link instead of showing a broken icon.
- Fixed Windows upgrade-install hanging / "cannot close".

## [0.3.1] - 2026-06-11

### 🔧 Fixed

- Fixed the macOS distribution's "local CLI" providers (claude / codex) failing due to an incomplete PATH when launched via Finder / Dock. (#21)

## [0.3.0] - 2026-06-11

> Highlights of this release:
>
> - **UI internationalization** (four languages + instant switching)
> - **Mermaid architecture-diagram rendering**
> - **Version-update detection**
> - pr-agent capability extensions such as `/improve` and the `/describe` approach-suggestion section
> - Fixes for first-launch sync, child-process-tree cleanup, and install / upgrade robustness
>
> ⚠️ **Windows upgrade note**: if an **earlier version** is installed (including `0.3.0-alpha.1` and earlier), **manually uninstall the old version first** before upgrading to this one (Settings → Apps → Code Meeseeks → Uninstall, or `Uninstall Code Meeseeks.exe` in the install directory), then run the new installer; otherwise the overwrite install may hang for a long time or pop "Code Meeseeks cannot be closed". Reason: at runtime, earlier versions wrote tens of thousands of Python bytecode (`.pyc`) cache files into the install directory, making the "uninstall old version" step of an overwrite upgrade delete a huge number of small files one by one — extremely slow, even hanging. From this release runtime no longer writes these caches, so **subsequent upgrades overwrite normally with no manual uninstall needed**.

### ✨ Added

- **Multilingual UI (i18n)**: integrates react-i18next, covering all GUI text and main-process user-facing text in **Simplified Chinese / English / 日本語 / Deutsch**; pr-agent output-template rendering is language-aware at render time.
  - Language selection: dropdown selection in the Settings page and first-launch wizard, effective immediately, with the AI reply language following (from the next run).
  - Language resolution: when `config.language` is empty, matches the OS preferred language, defaulting / falling back to en-US.
  - On-demand lazy loading: the default language enters statically, others are fetched only on switch (`ja-JP` / `de-DE` are machine first drafts).
- **Mermaid architecture-diagram rendering**: `mermaid` code blocks in markdown render to diagrams, covering PR descriptions / comments / chat review output, clickable into a modal preview (zoom / pan / fit to window), falling back to the raw code block on render failure.
- **Version-update detection**: at startup and on the Settings page, queries the latest stable release on GitHub Releases for comparison, prompting in the status bar with a click to go download when there's a new version (detection only, no auto-install), going through the configured outbound proxy, and can be turned off.
- **Enable the `/improve` command**: line-by-line code-improvement suggestions (with a 1–10 importance score), output landing in a separate `improve.md` split from `/review`.
- **/describe architecture diagram and approach-suggestion section**: uniformly enables GFM so the community-edition `/describe` selectively outputs a mermaid architecture diagram; and injects an "approach suggestions" section — 2–4 alternative implementation approaches (each collapsed) + a leaning recommendation.
- describe layout optimization: the architecture diagram and file changes each become a separate section with a colored-block heading, and file changes collapse by category.
- **Clear execution history**: a trash button added to the chat-panel title bar clears the current PR's execution history.

### 🔧 Fixed

- **Install / upgrade robustness**: reduces the number of small files in the install directory, alleviating slow / hanging uninstall on upgrade (an installed earlier version still needs a manual uninstall first).
- Fixed litellm and other grandchild processes being orphaned on cancel / timeout / exit.
- Fixed first launch "appearing not to trigger a remote sync" when the active connection has no cached identity.

## [0.2.0] - 2026-06-09

> Highlights of this release:
>
> - **GitHub integration** (github.com + GitHub Enterprise Server) and a multi-platform adaptation abstraction
> - **Concurrent review-task execution**
> - **Significantly faster startup**
> - **Removed the Docker run strategy**, converging to the embedded runtime

### ✨ Added

- **GitHub adaptation** (github.com + GitHub Enterprise Server, REST API v3): PR discovery, diff-comment read/write, inline comments, approval (approve / needs-work / revoke), merge; approval degrades per platform capability, and the approve button is grayed out for your own authored PRs.
- **Multi-platform adaptation baseline**: `PlatformAdapter` capability descriptors + comment-thread fields, with the UI showing / hiding / graying per capability bits, no platform checks written at call sites.
- **PR discovery categories**: GitHub aligns with the dashboard's four categories (To review / Created by me / Assigned to me / Mentioning me), Bitbucket adds two; results are cached locally and filtered locally by label.
- **Concurrent review-task execution**: the queue becomes configurable-concurrency (each run an independent worktree + child process), so multiple PR reviews run in parallel, with concurrency controlled by `pr_agent.max_concurrency` (1–8, default 2).
- **Local CLI model provider** (`cli`): hands review requests to a locally installed and authorized command-line tool (Claude Code / Codex CLI), with credentials and billing handled by that CLI.
- **Single-active-connection model**: the PR list and status bar reflect only the current active connection, archiving the old connection's PRs on switch.
- Added user-facing **user-guide** docs (`docs/guide/`): install and first use, platform / LLM / proxy config, config-file reference, custom review rules.
- Merge-button waiting state, preventing repeat clicks.

### ♻️ Changed

- **Faster startup**: adds a launch splash presenting the logo + spinner instantly; Monaco changes to lazy loading, shrinking the render entry bundle ~10MB → ~2.6MB; pr-agent detection moved off the window-creation critical path.
- Unified internal naming to **Bitbucket** repo-wide, removing ambiguous abbreviations like `BBS` / `BB` (pure rename).
- The architecture-design docs directory `docs/modules/` → `docs/arch/`.
- Logging enhancements: the dev console changes to single-line logfmt (colored by level, files still JSON); uncaught render-layer errors are relayed to main via IPC and logged together.

### 🗑️ Removed

- **Removed the Docker run strategy**: the embedded runtime + system local-cli already cover all scenarios, `pr_agent.strategy` no longer accepts `docker`.

### 🔧 Fixed

- Fixed multi-line free-text values returned by the model breaking pr-agent YAML parsing and crashing `/review`.
- Fixed a render crash on deleted-file line-number fragments.
- Fixed the first-launch wizard platform-card visual misalignment.

### 🔒 Security

- The GitHub image proxy attaches the PAT only for trusted GitHub / GHE asset domains, avoiding credentials being carried to third-party domains.
- Upgraded `nx` to 22.7.5 and fixed the `minimatch` ReDoS (high) dependency warning.

## [0.1.0] - 2026-06-08

> A localized, semi-automatic AI code-review desktop client **for individual Reviewers**,
> built on the community edition of [pr-agent](https://docs.pr-agent.ai/): pull PRs awaiting review, run AI locally to generate review opinions,
> confirm / edit each one, then publish to the code platform. **Decisions rest with the human, rules stay local, data stays local.**

### ✨ Added

- **Platform integration and PR discovery**
  - Bitbucket Server / Data Center integration (REST API v1, >= 7.0).
  - Polling auto-discovers Open PRs awaiting review where you are a Reviewer; grouped by repo, status-filtered, searchable.
  - First-launch config wizard: guides configuring the code-platform connection + (optionally) the LLM; returns to the wizard on next launch when a valid connection is missing.
  - Single-instance lock: a second launch focuses the existing window instead of opening another.
- **Local diff reading**
  - Bare mirror (on-demand clone / fetch) + Monaco side-by-side / inline diff.
  - File tree, inline comments, git blame, cross-file code search.
  - GitHub-style unchanged-section collapsing.
- **AI review (pr-agent)**
  - Conversationally drives `/describe`, `/review`, `/ask`, outputting structured, actionable findings.
  - Review-task queue: serial execution, queued tasks visible in chat, cancelable anytime, retry on failure.
  - Finding line-anchor clicks jump to the corresponding line in the Diff.
  - Real token-usage collection (input / output separately).
  - When the LLM is unconfigured, the chat panel gives a clear prompt and disables input.
- **Review → publish loop**
  - findings → draft pool → inline editing (Monaco view zone) → publish single / batch to remote.
  - Remote comments auto-refresh after publish; repeat publish is idempotent (local draft deleted once published).
  - Your own remote comments support reply / edit / delete.
  - One-click merge when the remote is mergeable; a toast prompts on approval / merge remote failure instead of failing silently.
- **Personalized rules**
  - Each Reviewer maintains their own rules directory (markdown + frontmatter), injected into the review after matching by project / repo / target branch.
- **Multiple LLM providers**
  - Adapted and tested: OpenAI, Anthropic, DeepSeek, Alibaba Bailian (Tongyi Qianwen), Volcano Ark (Doubao).
  - Vendors' first-party models take just the model name (litellm prefix auto-added per provider).
  - ollama / openai-compatible are theoretically workable (pending verification).
  - The Settings page offers visual CRUD for connection / LLM / proxy (draft state "write without enabling", applied only on save or explicit enable).
  - Outbound HTTP proxy: LLM calls / code platform / git HTTPS uniformly go through the proxy, with local addresses auto-direct.
- **Runtime and packaging**
  - Embedded relocatable Python + pinned pr-agent, works out of the box, no self-installed Python / Docker needed (Docker mode optional).
  - Desktop installers: Windows x64 (NSIS), macOS arm64 (dmg, ad-hoc signed, un-notarized).
  - A non-invasive patch system for pr-agent: binary-safe diff, new-model compatibility, YAML fault tolerance, token-usage collection, etc.
- **Privacy and data**
  - Local-first: reports no data to third parties beyond calling the configured LLM API and code platform.
  - Config / state / logs fixed under `~/.code-meeseeks/`; the repo mirror directory is configurable.

### 🔧 Fixed

- Fixed the pr-agent startup warning under a read-only install directory (e.g. `C:\Program Files`).

---

License: [Apache-2.0](LICENSE). The package bundles third-party components (pr-agent, Electron, etc.), each distributed under its own license, see [NOTICE](NOTICE).

[Unreleased]: https://github.com/huhamhire/code-meeseeks/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/huhamhire/code-meeseeks/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/huhamhire/code-meeseeks/compare/v0.1.0-alpha.1...v0.1.0
