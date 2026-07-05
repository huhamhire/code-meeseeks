# Agent & context

## Responsibilities & boundaries

The Agent is the shared foundation of both "conversation-as-delegation" and "automatic pre-review": a runtime that can be constrained by rules, reads the local layered context, and autonomously orchestrates pr-agent tools. This doc covers **the Agent's identity and context** — directory tiers, context injection, tool mutation red line, session isolation, prompt templates. The two usage modes each get their own doc:

- **Agentic sessions** (interactive natural language → delegation) — see [Agentic sessions](02-session.md).
- **AutoPilot automatic pre-review** (poll-triggered, cross-PR scheduling) — see [AutoPilot & scheduling](03-autopilot.md).

Owns: loading and injecting the Agent context directory (soul / conventions / memory / user profile / rules), the tool catalog and the authorization red line for mutating operations, session isolation and concurrency of writable memory, prompt templates and initialization.

Does not own: natural-language routing and the planning loop (see [Agentic sessions](02-session.md)), AutoPilot candidate filtering and scheduling (see [AutoPilot & scheduling](03-autopilot.md)), the pr-agent process itself and token collection (see [pr-agent runtime](05-pragent-runtime.md)), findings parsing and draft publishing (see [Review workflow](../01-platform/03-review-workflow.md)), the regex semantics of rule matching (see [Rules](04-rules.md); this module only holds the storage location of rule bodies, `<agent.dir>/rules/`), PR discovery / soft-delete / index (see [State storage](../99-core/01-state-storage.md)), platform write-operation APIs (see [Platform adaptation](../01-platform/01-adapter.md)).

> Relationship to the [rules system](04-rules.md): rule bodies live in the `rules/` subdirectory of the Agent directory (`<agent.dir>/rules/`); their matching semantics — "one file one rule + frontmatter matching + take all matches (capped at N) concatenated in Ruleset segments + per-tool injection into `EXTRA_INSTRUCTIONS`" — are defined by [Rules](04-rules.md). This module only handles loading and injection.

## Core design

### Agent directory: layered context

The Agent directory is the Agent's **complete persona and knowledge source**, mounted at the config `agent.dir` (a path; empty = fall back to the default location `~/.code-meeseeks/agent`). It has **no separate enable switch** — it works once an LLM is configured and pr-agent is ready. It is decoupled from application data and can point at a standalone directory or a team git repo.

Directory convention (a missing file is not blocking; if missing, that context tier is empty):

```
<agent.dir>/
├── SOUL.md      # Soul: core responsibilities, work boundaries, tone (Agent read-only · by default defined by the prebuilt template)
├── AGENTS.md    # Work conventions: review flow, AutoPilot trigger policy, tool-use red line (human-written)
├── MEMORY.md    # Long-term memory: facts accumulated across PRs / sessions (Agent may append, human may edit)
├── USER.md      # User profile: review preferences and personal habits (Agent may append, human may edit)
├── README.md    # Directory description: purpose of each file + pointer to the project (maintained by the human in a third-party IDE, not Agent context)
└── rules/       # Rule-based injection: "one file one rule + frontmatter" (human-written, see 04-rules)
    └── example.md  # A disabled example rule seeded once; not restored after deletion
```

Key trade-offs:

- **Layered rather than single-file**: `SOUL` defines responsibility boundaries (constant), `AGENTS` defines the flow and red line (constant), `rules/` defines the per-PR
  matched detail rules (structured, regex-matchable), `MEMORY` / `USER` are **writable memory** (the Agent accumulates them during work, the human can revise).
- **`SOUL.md` is read-only to the Agent**: the soul is a "constitution" the Agent itself has no right to rewrite — **the Agent is forbidden to modify `SOUL.md`**,
  and by default its content is **fully defined by the prebuilt template** (materialized at initialization, see "Prompt templates & resource directory" below). The constraint is enforced at runtime: when assembling context,
  `SOUL.md` is injected read-only, and the Agent's tool catalog has no capability to write `SOUL.md`; even if the LLM
  overreaches and produces a write operation against it, that is rejected (same source as the mutating red line under "Tool conventions" below). This way the Agent cannot redefine its own responsibilities and boundaries.
  Only a human (or the maintainer of the team git repo) can change `SOUL.md`.
- **Clear read/write boundary**: `SOUL` is human-changeable only (Agent read-only); `AGENTS` / `rules/` are primarily human-written; `MEMORY` / `USER`
  are writable memory co-written by Agent and human.
- **Whole-directory team sharing**: same idea as [Rules](04-rules.md) — point `agent.dir` at a git repo, and a team clone
  gets the same soul / conventions / rules. Although `MEMORY` / `USER` are writable, they remain shared context (in effect across PRs);
  writes go through atomic write (see "Session isolation" below).
- **Empty directory = degrade to native**: when `agent.dir` is empty (no Agent directory configured), the Agent runtime degrades —
  natural language falls back to the equivalent `/ask`, AutoPilot is unavailable, and pr-agent uses native behavior. This guarantees "usable even without configuration".

### Context injection: assemble the latest content on every run

**Every Agent run reads fresh and assembles fresh, with no cache** (consistent with [Rules](04-rules.md)'s "read rules fresh on each run"),
ensuring that a user who just edited `SOUL.md` / wrote a new MEMORY entry sees it take effect immediately. The Agent directory is a handful of small Markdown files;
the fresh-read cost is milliseconds, negligible against an LLM call that takes seconds; and it is naturally stale-proof — `agent.dir` often points at a team git
repo, and an external `git pull` happens outside the app, so a fresh read always gets the latest. Hence we **do not introduce an in-memory cache /
file watcher as the loading authority**: a watcher (cross-platform reliability pitfalls, self-writing `MEMORY/USER` re-triggering a loop) mainly benefits UI
reactivity rather than run-path performance, and may serve later as a side-channel signal (notifying the render layer to refresh the "currently matched rules" chip),
but correctness must never depend on it.

One assembly of the system context is concatenated in a fixed order:

1. `SOUL.md` body — persona and boundaries.
2. `AGENTS.md` body — work conventions and the red line.
3. **Tool catalog** — the name,
   semantics, params and **availability flag** (read-type / mutating) of the predefined tool instructions in the environment (`/describe` · `/review` · `/ask`, etc.), **injected** by the runtime rather than hard-coded into the prompt.
   Adding a tool only requires registering it in the catalog for the Agent to see it.
4. Matched `rules/` bodies — matched against the current PR context `{projectKey, repoSlug, targetBranch, tool}`,
   taking the first match (see [Rules](04-rules.md)).
5. `MEMORY.md` + `USER.md` bodies — long-term memory and user profile.
6. **Current PR metadata** — title / description / target branch / change overview.
7. **Current session snapshot** — this PR's todos and progress (see [Agentic sessions](02-session.md)), so the Agent can resume unfinished planning.
8. **Language behavior directives** — explicit i18n rules injected at execution time, covering two kinds of language behavior:
   - **AI output language**: the Agent / review artifacts output in the target language, following `config.language` /
     `resolveLanguage` (continuing the existing "AI reply language follows the UI language"; see the response-language injection in [pr-agent runtime](05-pragent-runtime.md)
     and [i18n](../03-gui/04-i18n.md)).
   - **Memory-write language**: when the Agent **appends new memory to `MEMORY.md` / `USER.md`, it records in the user's habitual language** (defaults to
     `config.language`, and can be refined by a language preference already recorded in `USER.md`), so the user can later read their own memory.
     This write-behavior rule **must be written explicitly into the prompt** — otherwise the Agent may record memory in the template's en-US or a random language.

**Three decoupled language concepts** (all three independent):

1. **What language the template / context files are written in**: a single en-US copy, user-editable (see "Prompt templates & resource directory" below).
2. **AI output language**: follows `config.language`.
3. **Memory-write language**: the user's habitual language.

`SOUL.md` may be in English while output and new memory still follow the user's language, e.g. Chinese; and vice versa — the set of execution-time rules in item 8
is the single point of control over both output and write behaviors.

The tool catalog's "availability flag" is the key to enforcing the red line (see "Tool conventions" below): a mutating tool, while unauthorized, is injected in a **disabled state**,
so the Agent knows it exists but cannot call it.

### Tool conventions: the red line for mutating operations

The tool catalog is split into two classes by side effect, treated **hard-differently** at runtime (not just by prompt constraint):

- **Read / analysis type** (`/describe` · `/review` · `/ask`, reading diff, reading findings, reading the PR list, etc.): the Agent
  may always invoke them autonomously. Note that `/describe` · `/review` themselves only produce local drafts and do not write the remote — they are safe operations.
- **Mutating type** (`/approve`, `/needswork`, publishing an inline comment, reply/edit/delete, merging a PR,
  and any write with a side effect on the remote): **by default the Agent is forbidden to invoke them autonomously**. They are released under only two authorizations:
  1. **The user issues a direct instruction** (explicitly asking for that operation in the session);
  2. **A rule grants it explicitly** (`AGENTS.md` / `rules/` explicitly grant AutoPilot some write permission, see "Write permission extension" in [AutoPilot & scheduling](03-autopilot.md)).

The red line is enforced at the runtime layer: a mutating tool, while unauthorized, is injected into the tool catalog in a **disabled state**, and the execution entry re-checks the authorization flag — so even if the
LLM "overreaches" and produces an `/approve` call, the runtime rejects it and records it in the transcript. This way "the prompt was bypassed"
does not equal "the operation was executed".

**Single source of truth for the tool list**: all tools (id / command name / read-vs-mutate classification / grant / whether it is a run-queue tool) are declared centrally in the
**unified registry `TOOLS` (tool-registry)** in the shared layer; the run-tool enum `ReviewRunTool`, the tool catalog `buildToolCatalog`, and the planning red line's
allow-set are all derived from it — adding / adjusting a tool changes only the one registry.

### Session isolation & rule sharing

- **Rule / context sharing**: `agent.dir` (SOUL / AGENTS / MEMORY / USER / rules) is a **single global copy**; all
  PRs' Agent sessions read the same set. Change one place, it takes effect everywhere.
- **Session isolation**: each PR's Agent session state (todo, progress, plan, transcript) is **isolated per PR**, landing under that PR's
  per-PR directory (see `state/prs/<hash>/` in [State storage](../99-core/01-state-storage.md)), with no cross-talk. Running Agents concurrently across different PRs is safe.
- **Concurrency of writable memory**: `MEMORY.md` / `USER.md` are writable files shared across PRs, and multiple sessions may append simultaneously → they go through the
  same **atomic write (tmp → fsync → rename)** as StateStore, serialized by the single-writer Main process;
  append semantics take priority (no whole-file overwrite), reducing the risk of concurrent mutual overwrite.

### Prompt templates & resource directory

- **Prebuilt templates in the repo**: the repo ships a default set of `SOUL.md` / `AGENTS.md` / `MEMORY.md` / `USER.md` / `README.md`
  plus an example `rules/`, as the **initialization skeleton** of the Agent directory. `README.md` is a user-facing directory description (purpose of each file + a pointer to the project's
  GitHub) for the user to read / maintain in a third-party IDE; it is not injected as Agent context.
- **Templates are a single en-US copy, no i18n**: the templates are the user's **authored content**, not product UI, so no multilingual variants are provided — they all land as
  **en-US** (consistent with the project's en-US fallback). After initialization the user may freely rewrite them into a target language (Chinese / Japanese …);
  they are editing their own context files, decoupled from the AI output language (the output language is controlled at a single point by the execution-time i18n rule in item 8 of "Context injection" above).
- **Unified resource-directory management**: the templates are placed centrally under the desktop app's **single resource directory**,
  packaged with the app (managed alongside resources such as the embedded runtime), and copied per manifest by the initialization logic; not scattered around.
- **Initialization timing and three ownership classes**: "initialize on use" — scaffold once before every load (not relying on one-off timing such as first launch / settings interaction),
  handled in three classes by file ownership:
  - **User-owned (create if missing, never overwrite)**: `AGENTS.md` / `MEMORY.md` / `USER.md` / `README.md` — editable Markdown,
    later rewritten by user and Agent per their respective permissions; if deleted, the next scaffold restores it (guaranteeing the base skeleton and directory description persist).
  - **App-owned (force-aligned to the template)**: `SOUL.md` — see the next item.
  - **Seeded once (landed only on first run, not restored after deletion)**: `rules/example.md` — the example rule is **not required**, seeded only on the Agent directory's **first scaffold**
    (determined by the `rules/` subdirectory not yet existing); once the user deletes it, it disappears permanently and is not "revived" on every startup.
- **`SOUL.md` is defined by the template by default**: the soul's content **by default comes entirely from the prebuilt template** (what initialization lands is the template body),
  and the Agent has no right to rewrite it throughout (see "Agent directory" above). This keeps the authority to define "who the Agent is and where its boundaries are" firmly on the template / maintainer side;
  a person or team wanting to customize still has a human change `SOUL.md` inside `agent.dir` (or maintain it uniformly in the team git repo),
  rather than handing it to Agent self-evolution.

## Data / interface contract

**Config (`agent.*` namespace)**: for the full fields and defaults see the config shape in [Config & secrets](../99-core/02-config-and-secrets.md); this doc only highlights the design points:

- **No separate enable switch**: it works once an LLM is configured and pr-agent is ready; `agent.dir` empty = fall back to the default location (not disabled).
- `strategy.max_followup_asks` (the hard cap on conditional `/ask`) belongs to `strategy`, not `autopilot` — manual auto review and AutoPilot share the same micro-flow (see [Agentic sessions](02-session.md), [AutoPilot & scheduling](03-autopilot.md)).
- `autopilot.grants` is per-item write-permission grants (empty by default = all denied).

**Agent directory file list**: `SOUL.md` / `AGENTS.md` / `MEMORY.md` / `USER.md` / `rules/*.md` (the rules'
frontmatter schema is in [Rules](04-rules.md)); plus `README.md` (user-facing directory description, not injected context) and the seeded-once
`rules/example.md` (a disabled example, not restored after deletion). The injected context takes only `SOUL/AGENTS/MEMORY/USER` from the former + the matched rule bodies.

**`ToolCatalogEntry`**: `name` / `semantics` / `params` / `mutating`(bool) / `enabled`(per authorization) — used for tool-catalog injection; the red line is enforced from `mutating` + `enabled`.

## Extension & caveats

- **The red line is a hard constraint, not a soft hint**: the authorization check for mutating tools must land at the runtime execution entry; it cannot merely be written into `SOUL.md` hoping the
  LLM behaves. Prompt and runtime are dual insurance; the runtime is authoritative.
- **Runaway risk of writable memory**: the Agent continually appending to `MEMORY.md` / `USER.md` may bloat / add noise →
  a size cap or recycling policy is needed (housekeeping can be added later), while keeping it human-editable at any time.
- **Language triad** (all three decoupled; don't bind "what language the file is written in" to "what language output / memory uses"):
  - **Template / context files**: a single en-US copy, no i18n (the user may rewrite into any language).
  - **AI output language**: controlled by the i18n rule injected at execution time, following `config.language`.
  - **Memory-write language**: when appending to `MEMORY.md` / `USER.md` the Agent records in the user's habitual language; this behavior rule must be
    injected into the prompt explicitly (see item 8 of "Context injection" above, and [i18n](../03-gui/04-i18n.md)).
- **Rule matching semantics are language-independent**.
- **Extensible later**: the Agent planner can hook into a local agentic CLI (claude / codex, etc., reusing the local CLI provider approach of
  [pr-agent runtime](05-pragent-runtime.md)) as the orchestration brain;
  the tool catalog can take in more read-only analysis tools (focus by changed_paths, cross-PR correlation, etc.) without touching the red-line framework.
