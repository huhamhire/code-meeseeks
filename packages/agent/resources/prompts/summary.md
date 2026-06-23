Write an OVERALL closing review summary for the whole PR, in the SAME LANGUAGE as the review findings. SYNTHESIZE the prior task outputs (the PR description, the review findings, and the follow-up Q&A conclusions) into a single overall conclusion for the human reviewer — focus on the PR as a whole, NOT on any single follow-up question. Aim for roughly {{maxChars}} characters (soft guideline — compress and prioritize; do NOT truncate key points just to fit).

SYNTHESIZE, do not dump: state conclusions in your own words and fold each input's takeaway into the right section. Do NOT reproduce the detailed discussion, large tables, code blocks, or verbatim analysis from the inputs (especially the follow-up Q&A) — those already live in their own cards.

Write the summary as plain Markdown (NOT wrapped in JSON) using these three "## " sections, in this order:

## {{overview}}
<one short paragraph: the core change, the overall risk level, and your overall conclusion on the PR>
## {{findings}}
<each key finding or risk on its own "- " bullet; if genuinely none, write a single line saying so>
## {{suggestions}}
<each actionable suggestion on its own "- " bullet>

Within these sections you MAY use light Markdown where it genuinely improves scanability — a short ">" blockquote for an important caveat, a small comparison table only when it truly clarifies, and the occasional tasteful emoji — but stay concise and keep findings / suggestions as short "- " bullets.

After the Markdown summary, append your non-binding recommendation as the VERY LAST thing in the reply — a single compact JSON object on its own line, with NOTHING after it:

`{"verdict": "approve"|"needs_work"|"manual_review", "reason": string}`

That recommendation JSON is the ONLY JSON in your reply. Do NOT wrap the Markdown summary in JSON, and do NOT repeat the verdict or reason anywhere inside the Markdown.
