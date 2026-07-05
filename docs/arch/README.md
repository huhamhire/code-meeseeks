# Architecture design docs (Architecture)

Captures the **current design and implementation conclusions** organized **by module domain** — "how it is now, why it's this way, how to extend it".
When understanding or maintaining a module, this is the **preferred entry point**.

## Relationship to other docs

- **This directory (arch/) = current conclusions**: continuously updated as the implementation evolves; the "source of truth" for a module.
- **ROADMAP**: delivered capabilities, ongoing evolution, risks and next steps; no implementation details (those live here).

## Per-doc skeleton convention

To aid searching and maintenance, every doc follows a uniform structure:

1. **Responsibilities & boundaries** — what this module is and isn't responsible for.
2. **Core design** — the design currently adopted + key trade-offs (why this way, not another).
3. **Data / interface contract** — outward-facing types, IPC channels, file formats and other stable contracts (described by name and shape).
4. **Extension & caveats** — how to extend it, and the points to watch when maintaining it.

> Principle: **describe the design; don't reference code files**. A doc is a durable design description, not bound to specific file paths
> (paths go stale, and they reduce a doc to a file index). Point to a concept / type / function name where needed,
> and let the reader grep by name in the code.
>
> Data-structure descriptions take a **tiered compromise**: internal domain types get "name + purpose + key fields" (grep the type name for the full field set);
> serialization / IPC / on-disk file and other stable contracts get a compact shape block; abstract interfaces list method names + semantics, no pseudo-signatures.

## Module index

Grouped into per-topic directories; both directories and docs carry a two-digit ordinal prefix (platform-first: platform integration → Agent → GUI → infrastructure):

```text
docs/arch/
├── 00-overview.md                  Architecture overview: process model / IPC / data flow / module relationships
├── 01-platform/                    Platform integration & PR operations
│   ├── 01-adapter.md                 Code-platform adaptation (PlatformAdapter / capability flags & degradation / multi-platform differentiation / clone protocol)
│   ├── 02-repo-mirror.md             Repo mirror & Diff (bare clone / worktree / blame)
│   ├── 03-review-workflow.md         Review→publish loop (commands / findings parsing / draft pool / publish / merge)
│   └── 04-comment-interactions.md    Comment interactions (emoji reactions / @mention completion / image attachments; capability-flag degradation / three-platform differences)
├── 02-agent/                       Agent & rules
│   ├── 01-agent.md                   Agent & context (directory tiers / context injection / tool mutation red line / session isolation / templates)
│   ├── 02-session.md                 Agentic sessions (input routing / planning loop / process retention / interaction control)
│   ├── 03-autopilot.md               AutoPilot & scheduling (automatic pre-review / admission gate / batch decisioning / micro-flow / priority queue)
│   ├── 04-rules.md                   Rules system (frontmatter / match priority; bodies stored under `<agent.dir>/rules/`)
│   ├── 05-pragent-runtime.md         pr-agent integration & runtime (bridge / embedded Python / sitecustomize / token usage)
│   └── 06-tool-token-cost.md         Tool token cost & context tiers (three-tier context model / root causes of cost blow-up / read-only retrieval guidance · /ask budget · codegraph evaluation)
├── 03-gui/                         GUI & interaction
│   ├── 01-ui-interaction.md          Render-layer layout / panels / cross-PR state persistence / interaction conventions
│   ├── 02-command-palette.md         Command palette (title-bar entry / two-level selection / search by language / registry + domain grouping)
│   ├── 03-notifications.md           Notifications (poll event projection / system notification toast / macOS dock badge / OS permission degradation)
│   └── 04-i18n.md                    Internationalization (react-i18next / dual runtime / key naming / translation conventions / template translation)
├── 04-integration/                 External integration extensions & CLI
│   ├── 01-service-api.md             Local API service & listener (loopback default / mandatory token / read + review write boundary / routes reuse the service layer)
│   └── 02-cli.md                     CLI tool (standalone Go binary / command tree / explicit connection config / cross-platform distribution)
└── 99-core/                        Infrastructure
    ├── 01-state-storage.md           State storage & data model (StateStore / per-PR directory / storage model + business lifecycle)
    ├── 02-config-and-secrets.md      Config & credentials (config.yaml / SecretStore / settings page / setup wizard)
    ├── 03-networking-proxy.md        Outbound network & proxy (unified HTTP proxy / loopback direct connection / SSH)
    └── 04-error-codes.md             Error codes & error propagation (AppError + meta / cross-IPC encoding / frontend i18n by code / registry)
```

> Packaging / build / signing are not product subsystems; they have moved to the development topic: [`../development/packaging-release.md`](../development/packaging-release.md).

## Numbering rules

- **Two-level numbering**: topic directories take a two-digit prefix (`01-platform` / `02-agent` / `03-gui` / `99-core`), docs within a directory take a further two-digit prefix starting at `01`; `00-overview.md` and this README stay at the root.
- Numbering is only for ordering and stable references, not a hard dependency; a new doc takes the next free number in its directory.
- **`99-core` takes the last slot `99`**: the infrastructure topic is always pinned last; new feature topics take `04`, `05`… in turn, inserted before it, with no need to renumber it.
