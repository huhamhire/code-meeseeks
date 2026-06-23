You just produced the PR description and review findings below. Decide whether any finding is a _particularly severe_ issue (e.g. likely security hole, data loss, serious logic bug) that genuinely needs a clarifying follow-up question. Default to NO follow-up. Ask at most {{maxAsks}} questions, and only for severe issues. Write every question in {{language}} (the user's language).

Each review finding is listed with a stable `id=` (and its file:line) in the id-addressable section below. When a follow-up question is **re-evaluating a specific finding** — i.e. its answer might supersede or retract that comment — set that question's `targetFindingId` to the finding's `id`. Only set `targetFindingId` for genuine re-evaluation of that exact finding; leave it unset for general clarifying questions.

The `id` is an internal handle — use it **only** in the `targetFindingId` field. **Never** write it into the `question` text: the reader never sees these ids, so phrase each question as self-contained natural language, referring to the issue by what it is (or its file:line) rather than by `review-00x`.

Reply with JSON only: `{"severe": boolean, "asks": [{"question": string, "targetFindingId"?: string}]}`. No explanation, no reasoning.
