# Custom Review Rules

**English** · [简体中文](zh-CN/05-rules.md)

Review rules let you inject your team's conventions, style preferences, and areas of concern into the AI review: the body of a matched rule is passed to pr-agent as `extra_instructions`, shaping the output of `/review` (and, optionally, `/describe`).

Rules are **plain files**: within a rules directory, each `.md` file is one rule. The `frontmatter` (the YAML at the top of the file) declares **when the rule matches**, and the body (markdown) is the **instruction injected into the AI** once it matches.

## Rules directory

The rules directory is the **`rules/` subdirectory under the Agent directory**: `<agent.dir>/rules/` (see [Config file reference · agent](04-config-reference.md#agent--advanced-agent--autopilot)). There's no separate rules path to configure — just drop rule files into that directory and they take effect.

```
<agent.dir>/            # defaults to ~/.code-meeseeks/agent; agent.dir can point at a custom / git repo
└── rules/              # rules directory: put .md rule files here
    ├── fx-amount.md
    └── api-breaking.md
```

When `agent.dir` is empty it defaults to `~/.code-meeseeks/agent`; pointing it at a git repo lets a team share and version their rules. You can organize files into subdirectories — the app recursively scans all `.md` files.

## Rule file structure

```markdown
---
applies_to:
  project: '^FX$'
  repo: '^fx-.*'
  target_branch: '^(main|release/.*)$'
tools: [review]
priority: 10
enabled: true
---

- Public methods must have JSDoc describing parameters and return values.
- Always store amounts as integer cents; floating point is forbidden.
- Changes to external interfaces must be flagged "Breaking" in the PR description.
```

- Between the `---` markers is the **frontmatter (YAML)**, declaring match conditions; the whole block may be omitted.
- After the `---` is the **body (markdown)**, injected as the AI's instruction once matched — clear, imperative, item-by-item statements work best.

### frontmatter fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `applies_to.project` | regex source string | omitted = matches any | Matches the project identifier: for Bitbucket the project key, for GitHub the org / username. |
| `applies_to.repo` | regex source string | omitted = matches any | Matches the repo slug. |
| `applies_to.target_branch` | regex source string | omitted = matches any | Matches the PR's **target branch** name. |
| `tools` | array | `[review]` | The tools the rule applies to; may be `review` / `describe`. Defaults to `/review` only (injecting review conventions into `/describe` makes the description drift off-topic). |
| `priority` | number | `0` | Weight for tie-breaking when multiple rules match at once — higher is more preferred (see "Matching & tie-breaking" below). |
| `enabled` | boolean | `true` | Per-rule toggle; when `false`, the file is skipped. |
| `custom_labels` | array | `[]` | Reserved field; parsed in the current version but not yet injected into pr-agent. |

> **About regex**: the values of `applies_to.*` are regex **source strings**, **not auto-anchored** with `^`/`$` — whether the match is exact is up to you. For example, `fx` matches any name containing `fx`; for an exact match write `^fx$`. An invalid regex is ignored (treated as if the field were unset).

## Matching & tie-breaking

When running a given tool on a given PR, rules are filtered by this logic:

1. **Tool filter**: if the rule's `tools` does not include the current tool → no match. **Note that `tools` defaults to `[review]`, not "applies to all tools"** — a rule without `tools` applies only to `/review` and does not affect `/describe`; to also constrain `/describe`, write `tools: [describe, review]` explicitly.
2. **Scope match**: for each `applies_to` field — omitted means match any; if set, the field value must pass its regex `.test()`. The three are combined with **AND** (all must hold).

> Unlike `applies_to`'s "omitted = matches any", the default of `tools` is a **concrete default value** `[review]`, not "any tool" — this is an easy point of confusion, so remember "unset = review only".

> **Multiple rules apply together**: all rules matching the same PR + tool are **injected together** — sorted by `priority` descending, then by file path ascending, with each rule's body concatenated as `Ruleset 1 / 2 / …` segments and passed to the AI, so they don't bleed into one another. `priority` determines the ordering (higher goes first). As a safeguard, at most **20** matched rules are injected per run; any beyond that are dropped from the tail of the sort order.

## Global base conventions

A rule file without frontmatter (or with it empty) = base conventions that **match any PR** (`tools` defaults to `[review]`). Good for a shared set of team-wide conventions:

```markdown
When reviewing, focus on:
- Whether error handling is complete and no exceptions are swallowed.
- Whether there's duplicated code that could be extracted and reused.
- Whether naming is clear and consistent with the surrounding code style.
```

## Examples

**Tighten by target branch**: harden checks only for PRs merging into `release/*`.

```markdown
---
applies_to:
  target_branch: '^release/.*'
tools: [review]
priority: 20
---

- This is a release branch; introducing new dependencies is forbidden.
- Any behavior change must have corresponding test coverage.
```

**Customize by repo**: apply only to a specific repo.

```markdown
---
applies_to:
  repo: '^payment-service$'
---

- Changes involving amount calculations need two-person review; flag risk points in the review.
```

## Notes

- **Changes take effect immediately**: after adding / removing / editing rule files, the next review loads the latest content, no restart needed.
- **A single parse failure doesn't affect the rest**: if one file's frontmatter YAML is malformed or a field has the wrong type, the app skips that file and continues loading the others.
- **Current-match hint**: after selecting a PR, the chat panel shows how many rules matched this run; click to preview all matched rules (listed by Ruleset segment), so you can confirm which rules constrain this review.

> For design and implementation details, see the architecture doc [docs/arch/02-agent/04-rules.md](../arch/02-agent/04-rules.md).
