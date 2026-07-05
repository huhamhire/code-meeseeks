# Rules system

## Responsibilities & boundaries

Let the review carry the team's/repo's coding conventions: store user-written rules, match by PR context, and inject matched rules into pr-agent's
`extra_instructions`.

Owns: rule loading/matching/injection. Does not own: pr-agent invocation (see [pr-agent runtime](05-pragent-runtime.md)), how the rule body is written (the user's business).

## Core design

- **The rules directory belongs to the Agent directory `<agent.dir>/rules/`**: rule bodies are part of the Agent's knowledge source, managed uniformly with the Agent directory
  (see "Agent directory" in [Agent](01-agent.md)), no longer a separate top-level `rules.*` config. When `agent.dir` is empty it defaults to `~/.code-meeseeks/agent`;
  a team points `agent.dir` at a git repo, and everyone's clone gets the same rules and context. Rules are pure "read", isolated from mutable state.
- **Markdown + YAML frontmatter, one file one rule**: recursively scan all `.md` under `<agent.dir>/rules/` (**directory levels don't participate in matching**, purely organizational,
  skipping hidden directories). The frontmatter is structured metadata, and **the markdown body is exactly the `extra_instructions` injected into pr-agent** — human-readable,
  clear in git diff, no duplicate content.
  - **Traversal-performance backstop**: recursively collecting `.md` in a single directory is capped at `MAX_RULE_FILES` (200); on reaching it, it stops and warns — preventing an `agent.dir` mistakenly pointed at
    a huge directory tree from scanning through a massive number of files in one load.
- **Matching semantics: read fresh on each run + take all matches (capped at N)**:
  1. Scan all `.md`, parse frontmatter (parse failure → warn + skip, non-blocking).
  2. Pre-sort by `priority desc + file path asc`.
  3. `.test()` each against the current `{ projectKey, repoSlug, targetBranch, tool }`: `enabled=false` / `tools` not containing the current tool /
     an `applies_to.<field>` regex not matching → skip; a missing field counts as a match.
  4. **Take all matches**, capped at `DEFAULT_MAX_MATCHED_RULES` (20) (excess discarded per the sort order from the back, a safety net against prompt bloat).
  5. Multiple bodies are concatenated by `combineRuleInstructions` in `## Ruleset N` segments (frontmatter has already been stripped by gray-matter at load time,
     not entering the body) as `extra_instructions`; the segment headings let the model distinguish different conventions without cross-contamination.
  "Global base + project override" can still be expressed with the priority number (base low, project high → sorted first, earlier Ruleset order).
- **Per-tool injection**: `/review` → `PR_REVIEWER__EXTRA_INSTRUCTIONS`, `/describe` → `PR_DESCRIPTION__EXTRA_INSTRUCTIONS`.
  Agentic review / planning goes through the "Matched rules" segment of the system context (same concatenation basis). The matched-rule count is logged during review execution.
- **Fail-safe**: a single file's broken frontmatter only skips that file; the rest of the rules load as usual.

## Data / interface contract

Rule-file frontmatter (all fields optional; omit = match any; a value is a **regex source string**):

```markdown
---
applies_to:
  project: "^FX$"                  # projectKey regex
  repo: "^fx-.*"                   # repoSlug regex
  target_branch: "^(master|main)$" # PR base branch name regex
tools: [review]                    # defaults to [review]
priority: 50                       # defaults to 0; larger is higher priority
enabled: true
---

# The body is extra_instructions (the convention given to pr-agent)
```

Config: the rules directory is fixed at `<agent.dir>/rules/` (`agent.dir` is in [Config & secrets](../99-core/02-config-and-secrets.md), empty = default `~/.code-meeseeks/agent`).

## Extension & caveats

- **The user must know regex** (learning cost); the UI can later provide helpers like "match by project" that auto-wrap into `^X$`.
- **Multiple matches all take effect**: matched rules are all injected in Ruleset segments (capped at 20), the UI's "matched rules" chip shows the match count,
  and the preview popover lists them one by one per Ruleset, making it easy to confirm which conventions constrain this review.
- Frontmatter is not strictly schema-validated; a wrong type silently falls back to the default value; validation can tighten once there are many rules.
- Extensible directions: match by `changed_paths`, rule lint/preview, a rule marketplace (import/export `.md` packs), a configurable match cap.
