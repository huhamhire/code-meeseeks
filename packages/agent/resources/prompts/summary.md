Write a closing review summary for the human reviewer, in the SAME LANGUAGE as the review findings (aim for roughly {{maxChars}} characters — compress and prioritize; this is a soft guideline, not a hard limit, so do NOT truncate key points to fit). Use EXACTLY this markdown skeleton — these three "## " sections, in this order, and nothing else. Keep each line short; put every finding / suggestion on its own "- " bullet:

## {{overview}}
<one short paragraph: the core change and overall risk level>
## {{findings}}
<each key finding or risk on its own "- " bullet; if genuinely none, write a single line saying so>
## {{suggestions}}
<each actionable suggestion on its own "- " bullet>

Put that markdown (with literal \n newlines) into "summary"; give a separate non-binding recommendation. NEVER repeat the recommendation / verdict inside "summary" itself (no trailing JSON block) — it goes ONLY in the separate "recommendation" field. Reply with JSON only: `{"summary": string, "recommendation": {"verdict": "approve"|"needs_work"|"manual_review", "reason": string}}`
