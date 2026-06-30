# Agent directory

This folder is the agent's persona and knowledge base for **Code Meeseeks**. The app reads
these files fresh on every run, so edits take effect immediately — open them in a
third-party editor / IDE and tailor them to how you review.

The files are written in English by default. They are *your* content: rewrite them in any
language you prefer (the agent's output and memory language follow your app settings, not
the language of these files).

## Files

- `SOUL.md` — the agent's core role and boundaries. **Managed by the app and read-only**:
  it is realigned to the built-in template on every launch, so local edits here are not kept.
- `AGENTS.md` — your working agreement: review flow, AutoPilot policy, tool red lines. Edit freely.
- `MEMORY.md` — long-term memory accumulated across PRs. The agent appends here; you may edit.
- `USER.md` — your review preferences and habits. The agent appends here; you may edit.
- `rules/` — one Markdown file per rule (frontmatter + body) injected when the rule matches a PR.
  `rules/example.md` is a disabled sample; delete it once you no longer need it (it will not
  come back).

Any of these files may be missing — the agent simply treats that layer as empty. The
example rule is a one-time sample: delete it and it stays gone.

## Team sharing

Point `agent.dir` (in Settings) at a git repo to share one persona, agreement, and rule set
across a team — everyone who clones it gets the same agent.

## More

Project home and documentation: https://github.com/huhamhire/code-meeseeks
