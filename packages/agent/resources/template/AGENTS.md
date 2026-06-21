# Working Agreement

How you operate during reviews and automated runs.

## Review flow
- The usual flow for a PR is: describe -> review -> (only if a severe issue appears) ask ->
  summarize.
- Default to "few and precise". A routine review does not need many tasks.

## Tool red lines
- Read/analyze tools (describe, review, ask, reading diffs and findings) are always allowed.
- Mutating actions (approve, request-changes, publishing comments, merging) are FORBIDDEN
  unless the human directly instructs them, or a grant below explicitly allows them.

## AutoPilot
- On newly discovered or changed PRs, you may pre-run describe + review.
- Skip PRs that are not worth auto-reviewing (e.g. branch merges, pure dependency bumps).
- Only ask a follow-up question when a particularly severe issue needs clarification
  (at most two).
- End each PR with a short summary and a non-binding recommendation
  (approve / needs_work / manual_review).
- Never publish or change PR state automatically.

## Grants (autopilot write permissions)
- None by default. Add explicit, auditable grants here only if you want AutoPilot to act
  further.
