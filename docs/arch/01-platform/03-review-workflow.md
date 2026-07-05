# Review → publish workflow

## Responsibilities & boundaries

The full chain from "run one review" to "comments landing on the remote": command execution → output parsed into structured findings → draft pool → the user confirms / edits / rejects / manually appends each → batch-publish as inline comments; plus comment reply/edit/delete and PR merge.

Responsible for: review-command orchestration, output parsing, the draft state machine, publishing. Not responsible for: running pr-agent itself (see [pr-agent runtime](../02-agent/05-pragent-runtime.md)), the platform comment API (see [Platform adaptation](01-adapter.md)).

## Core design

- **Three commands**: `/describe` (generate the PR description), `/review` (generate review findings), `/ask` (free-form Q&A). Conversational interaction + a **queue model**: concurrent execution of ≤ `pr_agent.max_concurrency` (default 2) runs, the rest queued FIFO; each run gets an independent worktree (path carries a nonce) + an independent subprocess, concurrency-safe; supports abort/retry; run state and live stdout survive across PR switches (a module-level store, not lost on component unmount).
- **Parsing output into findings**: pr-agent writes the result into a markdown in the worktree, and the parse layer splits by section, expanding the `/review` "key_issues / Recommended focus areas" section into multiple `code-feedback` findings (each with title + body + anchor).
- **anchor (file:line locating) merges two signals**:
  - Primary source: the embedded runtime's patched `get_line_link` renders the header as `[**header**](meebox:///<file>#L<s>-L<e>)`, and parsing takes its **structured anchor** (the path comes from the same source as the provider, most reliable).
  - Fallback: the prompt asks the model to append a `[file:…, lines:…]` marker in the body; when the link has only a path and no line numbers (the model didn't fill in the structured start/end), the marker's line numbers complete it (borrowed only within the same file, to avoid mismatches).
  - If none can be obtained, the anchor is left empty and the UI disables the "jump to edit" button.
- **Draft pool (does not publish directly)**: after `/review` succeeds, code-feedback findings automatically enter the draft pool as candidates; the user edits the wording / rejects / manually appends inline in the diff (DraftZone); **only after explicit confirmation are they batch-POSTed to the remote**. Running `/review` again discards the old pending drafts and uses the new results as candidates (edited/posted/rejected/manual are preserved).
- **finding state machine**: `pending → accepted/edited/rejected/posted`; on successful publish, `posted_remote_id` is recorded as the idempotency key to prevent re-sending.
- **Publishing goes through platform inline comments**: batch `publishInlineComment`, internally mapping the finding anchor to the platform anchor (see [Platform adaptation](01-adapter.md)).
- **Secondary comment operations**: reply / edit / delete (with can-edit/can-delete pre-checks: only your own authored comments may be operated on, re-validated on the remote); PR merge's entry is controlled by `mergeStatus.canMerge`, merge is irreversible and re-validated on the remote.
- **Token usage lands on the run**: the main process captures the subprocess stderr's `@@MEEBOX_USAGE@@` sentinel line by line and accumulates it (see [pr-agent runtime](../02-agent/05-pragent-runtime.md)), writing to `ReviewRun.tokenUsage`; the UI run meta shows ↑input / ↓output.
- **LLM-failure detection**: pr-agent may exit 0 while stdout is actually a full LLM failure (auth error / no available model) → the parse layer marks llmFailure and lands failed rather than "completed".

## Data / interface contract

Only the key fields carrying design meaning are listed; for the complete fields see each type definition:

| Entity | Purpose | Key fields |
| --- | --- | --- |
| `Finding` | a single review finding (the smallest unit of a draft / published item) | `anchor{path,startLine?,endLine?}` (inline anchor) · `sectionKey` (categorization) · state machine `severity` / `status` / `draft_body` / `posted_remote_id` (idempotent-publish credential) |
| `ReviewRun` | one review session (persisted in the per-PR directory, see [State storage](../99-core/01-state-storage.md)) | `tool` · `status` · `model` · `findings[]` · `tokenUsage{promptTokens,completionTokens,totalTokens,calls}` · `summary` |

## Extension & caveats

- **`/improve` is not wired up**: under pr-agent community edition + LocalGitProvider, `publish_code_suggestions` is unavailable, so the loop instead goes through "reusing `/review`'s code-feedback findings as inline candidates".
- **anchor coverage** depends on whether the model fills in structured line numbers + whether it outputs a marker; both paths are used to maximize coverage. When a historical run has no structured `tokenUsage`, the UI falls back to estimating from stdout.
- **Draft semantics**: rerunning `/review` clears only pending, to avoid mistakenly deleting the user's already-edited / already-published drafts.
- Publishing is a side-effectful remote write, so it must be idempotent (posted_remote_id).
