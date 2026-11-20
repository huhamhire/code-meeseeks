# Native review engines

> Status: design draft. The first desktop implementation covers automatic discovery, manual native review, and shared comment drafts. Further capabilities remain proposals. Updated 2026-11-19.
> Research baseline and evidence: [Codex and PR-Agent comparison](review-engine-comparison.md).

## Responsibilities & boundaries

Add an optional Codex native reviewer alongside the existing PR Agent experience. The header uses editor-style tabs, ordered **PR Agent → Codex**, within the current PR panel. Both engines share the review-to-publish workflow, while retaining independent execution and session state.

This design owns engine discovery, tab availability, engine-specific input controls, execution adaptation, and result provenance. Repository materialization belongs to [Repo mirror](../arch/01-platform/02-repo-mirror.md); findings, drafts, and remote publishing belong to [Review workflow](../arch/01-platform/03-review-workflow.md). Existing planning and AutoPilot behavior remain defined by [Agentic sessions](../arch/02-agent/02-session.md) and [AutoPilot](../arch/02-agent/03-autopilot.md).

The existing CLI provider and the proposed native engine are distinct. Selecting a Codex CLI profile today still runs PR-Agent prompts through that CLI. The native engine invokes Codex's dedicated reviewer. It does not require embedded Python or a working PR-Agent runtime, and it does not embed the Codex desktop application or call undocumented cloud PR endpoints.

## Core design

### Options and proposed direction

| Direction                                            | Benefit                                                                          | Cost / limitation                                                                                        | Decision                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Independent Codex tab with its own complete workflow | Fast experimentation and unrestricted presentation                               | Duplicates draft, publication, history, cancellation, and comment behavior                               | Avoid duplicating domain services          |
| Adopt review techniques inside PR Agent only         | Preserves one interface and multiple model providers                             | Requires building and maintaining repository exploration; does not directly exercise the native reviewer | Pursue selected improvements independently |
| One session with an engine selector                  | Compact UI                                                                       | Conceals differing context, conversation, and model ownership; makes comparison harder                   | Defer until capabilities converge          |
| Separate tabs with shared domain services            | Explicit engine choice and comparable results without duplicate publishing logic | Requires engine-aware state and capability adaptation                                                    | Adopt for the initial integration          |

### Automatic discovery and readiness

Codex is available only after the main process discovers a usable installed agent and verifies the capabilities required by the selected transport. A configured model profile, a directory named `.codex`, or an installed GUI alone is insufficient evidence.

Discovery uses the app process environment, including its resolved PATH and existing platform command-resolution utilities. Resolve executable paths and Windows npm launchers without shell interpolation. Probe only the selected known command with bounded `--version` and help/schema checks; do not scan disks for executable names or launch arbitrary discovered scripts. Capability checks take precedence over a guessed minimum version. The development baseline was Codex CLI 0.170.0; this is not a declared minimum supported release.

| State                                  | Tab and user behavior                                                       |
| -------------------------------------- | --------------------------------------------------------------------------- |
| Checking                               | Keep PR Agent usable; no selectable Codex session until discovery completes |
| Missing executable                     | Hide the Codex tab; settings explain discovery and offer a rescan           |
| Installed, unsupported review protocol | Show a disabled Codex tab with an upgrade explanation                       |
| Compatible, authentication required    | Show a disabled Codex tab with login guidance and a recheck action          |
| Compatible, readiness verified         | Enable the Codex tab                                                        |
| Probe failed or authentication unknown | Show a disabled tab with the specific recoverable state; allow recheck      |

Probe login through the CLI's supported status command or transport account-status method, without reading or returning credential files. Authentication readiness does not prove model access, quota, or service availability. Discovery must not send a paid model request, fetch a PR, install software, change CLI configuration, or initiate login automatically.

Recheck on explicit rescan and before starting a native run; invalidate cached discovery after a known installation/configuration change. Use a short-lived cache for routine renders. Treat a GUI process's PATH differing from a terminal's PATH as a diagnosable state. If the runtime disappears while selected, retain the transcript in a read-only view, disable new execution, and offer switching back; do not silently route to PR Agent.

### Tabs, controls, and model ownership

Each PR has independent PR Agent and Codex input buffers, history, active runs, scroll position, and engine session identifiers. Switching tabs changes the visible session without starting, stopping, or restarting a task. The inactive tab shows a running/unread indicator. Stop and clear-history controls act on the active engine session; clearing history must not delete published comments or the other engine's records.

In Codex mode, the PR Agent profile switcher is hidden. The Codex tab lists models from the local catalog and remembers the selected model across restarts. The main process validates that choice against the catalog and applies it to the next run.

Codex provides the account and default configuration. A short-lived local App Server process reads the model catalog using `model/list` over stdio. Opening the Codex tab loads the list through a five-minute cache. An explicit review choice sets `review_model` for that process. The picker does not write to the CLI configuration.

The first interaction model supports a native review action, read-only questions, and follow-ups on findings for the current comparison. Code Meeseeks owns the persisted exchanges and per-run checkout. Each question uses a fresh ephemeral exec and bounded local context assembled from recent exchanges and review evidence. Longer conversations may drop older exchanges. Native session resumption and semantic compression remain research topics.

### Shared execution with engine-specific adapters

Main owns discovery, process IO, and protocol handling; the renderer receives typed state and normalized events. Introduce an engine boundary that describes discovery/capabilities, starting a review, cancellation, and event/result adaptation. Keep transport details inside the Codex adapter; do not force native execution through the Python shim.

Both engines use the existing repository mirror, independent disposable worktrees, global concurrency budget, and visible task queue. A native review pins base SHA, merge-base SHA, and head SHA before execution. The worktree must represent that exact head with a stable local base ref. Verify that the native comparison matches the PR's three-dot diff, including detached HEAD and single-commit cases. PR updates create a new comparison scope; existing results retain their original scope.

Native code exploration must obey the app's instruction trust policy. Reviewed head content is evidence, not authority to change permissions. Use controlled worktree instruction loading with trusted base guidance, and verify nested instruction files and discovery paths before release. Do not solve sanitization by switching the reviewer back to a neutral directory that prevents repository exploration. Reuse the CLI's authentication, while enforcing read-only review permissions and the existing remote-write boundary; model instructions alone are insufficient enforcement.

| Transport                             | Strength                                                   | Integration cost                                                                 | Initial use                             |
| ------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------- |
| `codex exec review` with JSONL events | One process per run; easy isolation and bounded experiment | Must verify cancellation, terminal result shape, usage, and error events         | Preferred proof-of-concept transport    |
| Codex App Server `review/start`       | Explicit thread/turn lifecycle and interruption            | Handshake, protocol/version adaptation, server lifecycle, and session management | Evaluate for richer session integration |

Neither transport is selected solely from help output. Validate the installed version's actual event schema and behavior before declaring support. Do not automatically add the existing judge → follow-up ask → summary sequence around a native review; measure whether additional passes improve quality before paying for them.

### Findings, drafts, and provenance

Adapt engine output into shared findings and drafts. Preserve raw results separately from user edits. Show source engine and reviewed commit, and support common file navigation, quote, accept/edit/reject, and publish actions through existing services.

Refreshing one engine's review replaces only its own pending finding drafts for the relevant comparison scope. It must preserve the other engine's drafts, manual drafts, edits, rejections, and published records. Finding identity includes source run; similar findings from different engines are not silently merged or closed. A later comparison feature may group them visually while preserving source attribution and publication idempotency.

Validate paths against the reviewed worktree and convert them to repository-relative anchors. Check line bounds and diff applicability before offering inline publication. Invalid anchors retain a readable finding but do not gain a guessed location.

Transport success, parse success, and zero findings are separate states. Preserve unparseable final text with an output-compatibility warning. Never interpret an empty findings list produced by a parser fallback as proof that the review found no defects. Treat authentication, quota, unsupported model, timeout, interruption, and malformed output distinctly; no silent fallback to another engine.

## Data / interface contract

These are proposed concepts, not implemented IPC methods or a frozen storage schema:

| Concept               | Purpose / key fields                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Engine discovery      | Engine ID, resolved runtime/version, transport capabilities, readiness state, checked time, safe diagnostic code                |
| Session identity      | PR ID + engine ID; transport thread IDs are adapter details                                                                     |
| Review request        | Engine ID, PR ID, pinned comparison scope, review options, cancellation identity; native requests exclude GUI LLM profiles      |
| Review run provenance | Engine ID, engine version, base/merge-base/head SHAs, run ID, reported effective model and its source, terminal and parse state |
| Finding provenance    | Source run + engine, raw output reference, validated anchor, optional source priority/confidence and supporting evidence        |
| Usage                 | Reported token counts, cache counts and call/turn semantics when available; missing values remain unknown                       |

Map legacy run/session records to PR Agent on read. Plan a backward-compatible migration before adding another engine to storage. Keep recommendation, native overall correctness, and a real remote review decision separate; a native correctness result never automatically approves or merges a PR.

Define shared types and typed IPC before implementation. Any backend failure crossing IPC uses the existing `AppError` contract; renderer messages and new controls need all four locales. Native Codex review is a desktop interaction mediated by internal IPC. The local HTTP API and the meebox CLI expose PR Agent runs only, including queue listing and per-run cancellation. External agents integrate directly with their chosen runtime.

## Extension & caveats

### Delivery and acceptance

1. **Protocol experiment**: verify discovery, version/capability probes, auth-status handling, exact diff scope, output parsing, cancellation, child cleanup, and model metadata with a disposable local repository. No PR publication. Capture redacted fixtures for supported versions.
2. **Manual Codex tab**: add readiness gating and hidden model controls; reuse shared queue, persistence, finding cards, and draft services. Test PR/tab switches, simultaneous engines, stale controls, unavailable runtime, and process restart. Existing PR Agent remains usable without Codex installed.
3. **Quality evaluation**: compare both engines and selected workflow improvements using the [research protocol](review-engine-comparison.md). Broader conversation, AutoPilot, and dual-engine runs require separate decisions.

Required acceptance cases include model/profile controls never affecting Codex, independent pending drafts under concurrent reviews, invalid paths being rejected, interruption never appearing as a clean review, and retries retaining their own run identity. Verify on Windows and macOS with GUI-launched PATH and installed-app permissions.

The reviewed sources establish integration possibilities and implementation differences. They do not establish parity with Codex's hosted GitHub review service, superior review quality, or a lower execution cost.
