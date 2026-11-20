# Codex and PR-Agent review comparison

> Versioned capability comparison and evaluation protocol. Upstream baseline checked 2026-11-19.
> See [Review workflow](../arch/01-platform/03-review-workflow.md) for the current integration and [Native review extensions](../drafts/native-review.md) for open design questions.

## Responsibilities & boundaries

Compare public Codex native local review with community PR-Agent, identify useful design techniques, and define what to measure before changing the default review flow. Keep upstream capability, Code Meeseeks integration, and observed model quality separate.

The baseline is the installed **PR-Agent 0.50.0** runtime and public **Codex `rust-v0.170.0`** source. Local `codex --version` reported **0.170.0** during this investigation; earlier incident logs referenced 0.161.0. Read-only help probes confirmed native review, JSONL output, login-status, and App Server commands. No model review or remote publication was executed for this research. The earlier PR-Agent offline tests verify integration contracts using synthetic responses; they are not review-quality evidence.

Public local-review source does not establish the implementation, prompts, or service policy of Codex's hosted PR review product. Recheck transport contracts for the supported installed CLI version.

## Core design

### Confirmed capability differences

| Dimension            | Codex native local review                                                                                                                                                  | Community PR-Agent 0.50.0                                                                                                                                              | Consequence for Code Meeseeks                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Execution model      | A dedicated reviewer runs within the local agent runtime, with a review rubric and repository tools. The native task restricts web search and collaboration features. [C2] | Tool-specific pipelines prepare model input and process responses; `/review` is primarily prepared diff/context analysis. [P1]                                         | Compare repository exploration against prepared-context review; do not assume native review fans out to multiple agents |
| Comparison scope     | Review targets include base branch, commit, uncommitted changes, and custom instructions; base-branch preparation computes a merge base. [C1, C3]                          | Providers prepare PR diffs; local mode compares repository commits. Chunking and token budgets bound large inputs. [P1, P3]                                            | Pin identical comparison SHAs before comparing output                                                                   |
| Context and guidance | The review rubric applies scoped project guidance and asks for rule attribution where relevant. [C4]                                                                       | Repository context, extra instructions, and optional configured skills augment prompts; context fetching has explicit budgets. [P1, P3]                                | Neither engine lacks project guidance; investigate discovery and trust boundaries separately                            |
| Finding selection    | The rubric emphasizes introduced, actionable defects, concrete affected paths, restrained severity, compact anchors, and valid empty results. [C4]                         | The shipped reviewer prompt already asks for concrete scenarios, introduced defects, and limited speculation; high-impact uncertainty can be reported explicitly. [P4] | Much of the quality policy overlaps; copying prompt wording alone has limited expected value                            |
| Verification         | The reviewer can investigate through its agent runtime; the inspected task does not establish a mandatory separate verification pass or universal test execution. [C2]     | `/improve` performs suggestion reflection, scores feedback, and validates replacements. `/review` has its own validation path. [P1, P2]                                | Distinguish evidence gathering, model reflection, and deterministic validation                                          |
| Result contract      | Native output includes findings, priority/confidence, locations, and overall correctness; the task can fall back to plain text on parse failure. [C2, C4]                  | Prompt YAML is validated against Pydantic models; CLI JSON output is also available for review, improve, and describe. [P1, P5]                                        | Prefer structured adapters for both; the current app's Markdown parsing is an integration choice                        |
| Product scope        | The local reviewer concentrates on code review; its presence does not supply the app's description generation, draft lifecycle, or multi-platform publication. [C1]        | Separate describe/review/improve/ask tools and hosted-provider integrations support a broader PR workflow. [P1, P2, P3]                                                | Keep shared publication services and retain PR Agent's broader tool coverage                                            |
| Model and cost       | Native task selects `review_model` when set, otherwise the current model; repository exploration can involve multiple tool/model turns. [C2]                               | Models and fallbacks are configurable; chunking, suggestion reflection, and the app's outer orchestration can add calls. [P1, P2, P3]                                  | Record the effective model when available and measure the full cost of each workflow                                    |

Community PR-Agent is not synonymous with this app's PR Agent tab. Code Meeseeks adds planning, judge/follow-up asks, re-review closures, shared memory, rules, queues, and draft publication around upstream tools. In current CLI mode, review/describe send prepared prompts through Codex in a neutral directory; `/ask` can use a sanitized repository worktree. These are app decisions, not inherent limitations of Codex or every PR-Agent deployment. See [sessions](../arch/02-agent/02-session.md) and [runtime](../arch/02-agent/05-pragent-runtime.md).

### Adopted workflow changes

The desktop implements structured results and coverage, fixed comparison snapshots and verified anchors, bounded evidence gathering, and progress reporting. Current behavior is maintained in [Review workflow](../arch/01-platform/03-review-workflow.md), [AutoPilot](../arch/02-agent/03-autopilot.md), and [PR Agent runtime](../arch/02-agent/05-pragent-runtime.md). The evaluation below measures the effects of those changes.

### Evaluation protocol

Use a fixed set of representative PR snapshots: small changes, large changes, cross-file contracts, tests, legitimate intentional changes, and known regressions. Include clean PRs. Freeze base/merge-base/head SHAs and record trusted guidance, selected configuration, runtime versions, and each engine's reported model. Do not infer an effective model from a profile label.

Run two complementary comparisons: the normal product experience with each engine's own configuration, and a controlled comparison with matched model/effort where both interfaces support it. Record when matching is impossible. Keep human assessment independent of engine identity, repeat a subset to expose run variance, and count unique validated defects rather than raw comments.

| Measurement                 | Evidence to retain                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| Precision                   | Accepted actionable defects divided by adjudicated findings, with rejection reasons                       |
| Known-defect recall         | Known/seeded defects found divided by the relevant labeled set; natural PRs have no complete ground truth |
| Anchor and evidence quality | Correct file/range, accurate trigger and impact, verified rule/caller/test references                     |
| Priority agreement          | Human-assigned levels, P1 precision, high-impact findings ranked too low, and agreement across models     |
| Cost and latency            | Full-run elapsed time, available usage, calls/turns, retries, follow-up overhead, and manual triage time  |
| Reliability                 | Completion, auth/model failures, cancellation, truncation, parse errors, and incomplete coverage          |
| Workflow usefulness         | Draft adoption/edit/rejection, duplicate comments, and reproducibility on the same snapshot               |

A self-reported confidence or reflection score is not a calibrated correctness probability. Do not compare billing by raw token totals across providers or cache conventions. If monetary cost is unavailable for an account, keep it unknown. Select an improvement only when its measured benefit justifies its added complexity and execution cost; establish acceptance thresholds before collecting results.

## Data / interface contract

The experiment needs a snapshot identity, engine/runtime identity, reported model provenance, raw and normalized results, completion/parse status, available usage, and human adjudication. These are research records, not a new public API. The current run and finding contracts are defined in [Review workflow](../arch/01-platform/03-review-workflow.md).

Evidence sources inspected for this research:

- **C1** — [Official App Server review protocol](https://learn.chatgpt.com/docs/app-server), plus local CLI help probes described above.
- **C2** — [Codex 0.170.0 review task](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/core/src/tasks/review.rs): task restrictions, model selection, lifecycle, and result parsing.
- **C3** — [Codex 0.170.0 review request preparation](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/prompts/src/review_request.rs).
- **C4** — [Codex 0.170.0 review rubric](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/prompts/templates/review/rubric.md).
- **P1** — [PR-Agent 0.50.0 reviewer](https://github.com/qodo-ai/pr-agent/blob/v0.50.0/pr_agent/tools/pr_reviewer.py), checked alongside the installed distribution.
- **P2** — [PR-Agent 0.50.0 suggestion pipeline](https://github.com/qodo-ai/pr-agent/blob/v0.50.0/pr_agent/tools/pr_code_suggestions.py), including reflection and scoring.
- **P3** — Installed distribution: `pr_agent/settings/configuration.toml`, `algo/repo_context.py`, and `algo/skills_loader.py`; upstream [configuration](https://github.com/qodo-ai/pr-agent/blob/v0.50.0/pr_agent/settings/configuration.toml).
- **P4** — Installed distribution: `pr_agent/settings/pr_reviewer_prompts.toml`; upstream [reviewer prompt](https://github.com/qodo-ai/pr-agent/blob/v0.50.0/pr_agent/settings/pr_reviewer_prompts.toml).
- **P5** — Installed distribution: `pr_agent/cli.py`, `algo/output_models.py`, and `algo/review_json_output.py`; upstream [CLI](https://github.com/qodo-ai/pr-agent/blob/v0.50.0/pr_agent/cli.py).

## Extension & caveats

For future transports, validate the installed runtime output using captured fixtures. Record which native structured fields the external protocol exposes and how they map to the desktop adapter.

Evaluate review quality, evidence retrieval across repositories, priority accuracy, effective model reporting, usage, and cross-platform cancellation. Hosted PR review parity requires separate evidence. Refresh the upstream comparison when either baseline version changes.
