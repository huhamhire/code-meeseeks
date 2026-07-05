# Tool token cost & context tiers

## Responsibilities & boundaries

Focus on the **context sources and token cost model** of the pr-agent tools (`/describe` `/review` `/improve` `/ask`) and the free-conversation Agent:
how many tiers the context has, at which tier cost scales up, and by what means to converge it without sacrificing review depth. The runtime mechanisms (invocation bridge / embedded
Python / monkeypatch / token collection) are in [pr-agent integration & runtime](05-pragent-runtime.md); agentic sessions and the planning loop are in
[Agentic sessions](02-session.md); worktree materialization is in [Repo mirror](../01-platform/02-repo-mirror.md).

Conclusion first: cost scaling concentrates in "`/ask` under the local agentic CLI provider" and "the free-conversation Agent's planning loop" — the former can
read files across multiple turns in one exploration, the latter can fire multiple such `/ask` in a row. **There is no "diff-only blind review"**: by default pr-agent already injects the
near-end context of the change (the enclosing function / class, surrounding lines, the whole new file, best-practices) into the prompt.

## Three-tier context model

Review context is not "diff vs whole repo, pick one" but three progressive tiers:

| Tier | Context | Cost | Where used in this repo |
|----|--------|------|-------------|
| 1 · bare diff | only `+/-` lines | very low | none (not used standalone) |
| 2 · **expanded diff (pr-agent default)** | diff + dynamic context extended to the **enclosing function / class** + hunk surrounding lines + the whole new file + best-practices | **bounded, deterministic** (constrained by `MAX_MODEL_TOKENS`) | `/review` `/describe` `/improve`, and the base of `/ask` |
| 3 · agentic exploration | read any file on demand, follow the call chain, cross-file cross-check | **unbounded** (turns × accumulated context, near-quadratic growth) | only `/ask` + the CLI provider (hands down the worktree cwd); the free-conversation Agent can trigger it multiple times across steps |

Tier 2 is pr-agent's established answer to "a bare diff isn't enough to review": include the change's near-end blast radius at a deterministic cost, rather than letting the agent explore
freely. pr-agent has it on by default ([configuration.toml](../../../apps/desktop/vendor/pragent/python/Lib/site-packages/pr_agent/settings/configuration.toml):
`allow_dynamic_context=true`, `patch_extra_lines_before=5`/`_after=1`, `max_extra_lines_before_dynamic_context=10`,
`best_practices`, etc.); this app does not override these defaults, so `/review` naturally enjoys tier-2 context — what's missing is the **remote** context (callers in other
files, cross-module contracts, invariants several files away).

Tier 3 is only in CLI-`/ask`: `buildInvocation` hands down `MEEBOX_CLI_WORKDIR` only when `tool==='ask' && provider==='cli'`, letting the
agentic CLI read files in the worktree and iterate across turns. At this point the CLI **still first receives the pr-agent-rendered expanded diff** (see the `The PR Git Diff` of the pr_questions template) —
it is not "only the question, searching from scratch", but "already has tier 2, then explores tier 3".

## Cost drivers

- **CLI-`/ask`'s agentic exploration (tier 3)**: the worktree is readable with no turn cap, tending toward whole-file read-throughs / whole-repo scans; each turn carries the
  ever-growing conversation + tool results and re-transmits, near-quadratic growth. In CLI mode `MAX_MODEL_TOKENS` is ignored (the CLI self-manages the context window),
  with no app-side input cap.
- **The free-conversation Agent's planning loop**: constrained only by the "Agent max steps" `max_steps` (default 8), it can fire `/ask` in a row across multiple steps, each being
  one tier-3 exploration — without extra constraints, cost gets out of control as the steps stack.

Tier 2 (including the API provider's `/ask`, all review/describe/improve) is a single-turn, token-budget-hard-constrained deterministic cost.

## Optimization measures

Goal: make tier 2 sufficiently full (cheap, deterministic), and make tier 3's **necessary** exploration more efficient and its **quantity** controlled — rather than cutting exploration to degrade the review.

### Implemented

- **CLI-`/ask` read-only code-retrieval directive**: `buildExtraInstructions`'s `worktreeRetrievalDirective` (injected only for the CLI provider)
  guides taking the diff as the true source of the change, **searching for symbols in a targeted way · reading only the needed line ranges** instead of whole-file read-throughs and whole-repo scans, stopping once sufficient. It deliberately uses only the **read-only**
  tool set — under headless (no TTY), claude default permission mode silently allows built-in read-only tools (Read/Grep, plus `grep` · `git log/show`
  and other read-only Bash commands) with no authorization friction, but for a non-read-only tool (writes, plus `rg` and other commands not in the built-in read-only whitelist) it does not
  reject but **aborts the session outright**, so it makes explicit "use `grep` not `rg`" and forbids mutating commands. It relies only on the cross-version-stable semantic of "built-in read-only tools are silently allowed",
  without adding `--allowedTools`/`--permission-mode` and other startup args that depend on a specific claude version.
- **The free-conversation Agent's `/ask` budget**: the planning loop caps this session's `/ask` count per the configured "follow-up count" `max_followup_asks`,
  and on reaching the cap rejects a new `/ask` at the red-line check and feeds it back (prompting the model to wrap up from the existing context or switch to a read-only tool); `describe/review/improve`
  are not subject to this, and `max_steps` is unchanged. **count-only**: it always takes effect per the configured follow-up count, independent of the "auto follow-up" switch (the switch only constrains
  the conditional follow-up of the review micro-flow). The review-micro-flow-side conditional follow-up (the judge step) shares the same config value as this budget.

### Rejected

- **Pre-injecting a unified diff for CLI-`/ask`**: the CLI-`/ask` prompt already carries pr-agent's expanded diff via the pr_questions template (tier
  2), and injecting another copy only duplicates the context, bloats the prompt, and does not reduce tier-3 exploration (which exists to get the remote context beyond the diff).

### Under evaluation (deferred)

- **codegraph as a retrieval tool**: swap "blind reading" for "targeted query (definition / callers / impact surface)", converging tier-3 waste. **Applies only to
  the agentic path with a tool loop (`/ask`)**: mounted as an MCP server for the headless CLI. `/review` is a single-turn tool with no tool loop, and
  codegraph for it can only be **orchestrator-side pre-injection** (select the remote context when composing the prompt and splice it into tier 2), rather than "a tool passed to review".
  Cost: a worktree is temporary on each materialization, requiring building the graph each time or switching to incremental maintenance and freshness-keeping on a long-lived mirror; claude supports MCP, codex does not support
  external MCP injection. Better to adopt it only when the existing measures still fall short.
- **Agentic turn cap for a single `/ask`** (claude `--max-turns`): as a safety net, not a primary cost lever; it depends on a specific CLI version's support for that
  flag, so not introduced for now.

## Related / See also

- [pr-agent integration & runtime](05-pragent-runtime.md): invocation bridge / embedded runtime / monkeypatch / token collection / env injection.
- [Agentic sessions](02-session.md): the planning loop (ReAct), the step cap, process retention.
- [Repo mirror](../01-platform/02-repo-mirror.md): worktree materialization and the three-dot diff basis.
