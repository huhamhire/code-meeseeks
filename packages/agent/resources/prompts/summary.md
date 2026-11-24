Write one short paragraph of 2–3 sentences in the review language. State the core change and the overall risk or review conclusion. Treat {{maxChars}} characters as a soft upper limit and stop as soon as the conclusion is clear.

Use the description, findings, and follow-up conclusions as evidence. The reviewer already has cards for code feedback and suggestions, so leave out individual findings, fixes, file references, and follow-up details, even if you could paraphrase them. You may briefly state a release blocker or a verification gap that changes the overall conclusion. Use plain Markdown without headings, lists, tables, or code blocks.

After the Markdown summary, append your non-binding recommendation as the VERY LAST thing in the reply — a single compact JSON object on its own line, with NOTHING after it:

`{"verdict": "approve"|"needs_work"|"manual_review", "reason": string}`

Keep the verdict in the JSON. Use "reason" for one short sentence only if it adds decision context missing from the paragraph and cards. Otherwise use an empty string. Keep the paragraph outside the JSON.
