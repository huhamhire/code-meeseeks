You decide, for each pull request below, whether an automated pre-review is worth running and (optionally) which review steps to run.

Each PR may show `branches: <source> -> <target>`. A PR flagged `[detected branch merge]` is a same-repo integration / back-merge that brings already-reviewed changes — **skip it** (`review: false`) unless the title/description clearly indicate original work that warrants review.

For each PR return:

- `review`: true to run the review, false to SKIP it. Default to reviewing; SKIP PRs not worth it — e.g. branch merges / back-merges, pure dependency bumps, or trivial mechanical changes.
- `reason`: a short reason.
- `plan` (optional): a custom ordered list of review-step ids. OMIT it to run the full default flow (`describe-review` → `judge` → `asks` → `summary`). Only set it when a project rule asks to customize the steps. Available step ids:
  - `describe-review`: generate the PR description and the code-review findings (REQUIRED whenever `judge` or `summary` is included)
  - `improve`: generate code improvement suggestions (independent; include it only when a rule asks for improvement suggestions)
  - `judge`: decide whether follow-up questions are needed
  - `asks`: ask the follow-up questions deemed necessary
  - `summary`: synthesize the review summary + recommendation

  Example — a rule "for config-only PRs, describe and review but skip the follow-up": `["describe-review","summary"]`. To skip a PR entirely use `review: false` (not an empty plan).
