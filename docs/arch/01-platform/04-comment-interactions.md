# Comment interactions

Three kinds of manual interaction on top of PR comments: **emoji reactions**, **@mention autocomplete**, and **image attachment upload**. All three build on the existing comment read/write loop (see [Review workflow](03-review-workflow.md)) and the platform adaptation layer (see [Platform adaptation](01-adapter.md)), showing / hiding and degrading per platform capability flag.

## 1. Responsibilities & boundaries

- **Responsible for**: the "interaction enhancements" on comments — adding / removing an emoji reaction on an existing comment and showing the aggregate; in-place autocompletion of `@mention`-ing a user while writing a comment / reply; pasting an image to upload while writing, and backfilling the body.
- **Not responsible for**: the CRUD and replies of the comment body itself (belongs to review workflow 05), inline-comment anchoring (belongs to diff), markdown rendering of the comment body and the proxied fetch of embedded images (an existing capability; this domain only reuses its rendering after an upload).
- **Boundary principle**: interaction is a **pure gain** — if any item is unsupported by the platform, or its data fetch fails, it must not affect the normal loading and display of the comment list (best-effort; silently degrade on failure).

## 2. Core design

### Capability-flag-driven show/hide degradation

Each of the three is declared by a capability flag (`commentReactions` / `commentAttachments`, and @mention needs no backend capability), and the render layer shows / hides the entry accordingly. If the platform doesn't support it, the whole block does not appear, and no `if (platform === …)` is written at the call site (following 01's degradation paradigm). `commentReactions` takes three states `false | 'fixed' | 'free'` — `fixed` is a fixed set only (GitHub's 8, no search), `free` supports any emoji (a curated set + search).

| Capability | GitHub | Bitbucket | GitLab |
| --- | --- | --- | --- |
| Reactions `commentReactions` | `'fixed'` (8) | `'free'` (7.x+) | `'free'` |
| Attachments `commentAttachments` | ✗ (no public upload API) | ✓ | ✓ |
| @mention local completion | ✓ (no flag; always on) | ✓ | ✓ |
| @mention remote search `userSearch` | ✓ `collaborators` → `/search/users` on 401/403 | ✓ `/users?permission=LICENSED_USER&filter=` (native picker endpoint) | ✓ `/projects/:id/users` (any member) |
| File-level comments `fileLevelComments` | ✓ `subject_type: "file"` | ✓ anchor without a line | ✗ (no file-level diff-comment API) |

### emoji reactions: unify the emoji character as a neutral key

Each platform's native reaction identifier differs — GitHub uses a fixed set of 8 content values (`+1`/`laugh`…), GitLab uses award emoji names (`thumbsup`…), Bitbucket uses emoticon shortcuts (`eyes`…). The neutral model `PrReaction` keys on the **Unicode emoji character** (`{ emoji, count, mine }`), so the render layer draws it directly, consistent across platforms; **the native-name ↔ emoji mapping is held privately by each platform's adapter** (which knows its own API best).

The picker takes candidates by mode:

- **`fixed` (GitHub)**: use `REACTION_PICKER` — a fixed set of 8, no search (aligned with the GitHub Reactions API cap).
- **`free` (GitLab / Bitbucket)**: use the **built-in curated large set** `REACTION_EMOJIS` (~150 high-frequency emoji + standard shortcode + search keywords) + a search box.
- **Native-name mapping**: GitLab award names / Bitbucket emoticon shortnames are both standard emoji shortcodes, so the char ↔ native-name mapping for both free ends (`emojiToReactionCode` / `reactionCodeToEmoji`) is uniformly derived from that set.
- **Out-of-set emoji**: a reaction a user made via the web with an out-of-set emoji is still **displayed** by its character (best-effort: Bitbucket decodes the code point from the twemoji url, GitLab looks it back up by award name), only the picker doesn't offer it.
- **Backward extension point**: to add a reaction, append a row in `REACTION_EMOJIS` (emoji + correct shortcode + keywords) and both free ends' adapters take effect automatically; the fixed set is maintained separately in `REACTION_PICKER` + the GitHub content mapping.

Deliberately using a **built-in curated set** rather than the full Unicode / a third-party large lexicon, for two reasons:

- avoid packaging bloat and "silent write failure of an emoji newer than the instance's Twemoji version" (e.g. Bitbucket measured to ship Twemoji 12.1.2, ~1180, of which a full lexicon is a superset);
- the curated set's shortcodes are controlled and its writes are reliable.

The cost is that long-tail emoji can't be searched — assessed as sufficient for the review scenario (including common items like alien).

To avoid being clipped by the comment scroll container / interfering with other layers' z-index, the picker is rendered **via a portal to body + fixed positioning**, with coordinates computed from the trigger button's position + viewport space (auto-flip up/down, horizontal clamp), and recomputed on scroll / zoom; clicking outside the popover / Esc dismisses it. The "add reaction" button sits inline in the comment action-button row, and existing reactions are shown on a separate line below it.

**Bounding the reads**: fetching the reaction aggregate is handled per platform difference, and always best-effort (a single failure doesn't drag down the list) —

- GitHub: comment responses carry reaction counts, so display needs no extra request; only "whether the current user has reacted" (`mine`) needs a follow-up query, and **only for comments that have reactions** (counts > 0), so the number of extra requests is bounded by the real reaction count.
- GitLab: notes don't embed awards, so award_emoji must be queried per note (in parallel); a single failure is caught as no reaction.
- Bitbucket: reactions are returned along with the comment's `properties.reactions`, **zero extra requests**.

**Toggle semantics**: `toggleReaction(add)` is idempotent — on add, a duplicate add is treated as success; on remove, GitHub/GitLab must first find the id of one's own reaction and then delete it, skipping if it doesn't exist. On success it follows the existing "clear cache after write + broadcast `comments:changed` + refetch" model, maintaining no frontend optimistic state (consistent with edit / delete).

### @mention: participant candidates + remote search fallback

Notification is done by the platform server automatically for `@name` in the comment body, so it takes effect with **zero backend change**; this domain only handles the completion UX while writing.

The candidate source has **two layers**, local-first:

1. **Local participants (default, always on)**: the **participants already loaded for this PR** — comment authors (including replies recursively) + commit authors — deduped by name. A **bounded, zero-extra-fetch, safe** source: it doesn't enumerate everyone from the remote, and the candidate size roughly equals the participant count (usually < 20). After typing `@`, client-side filter by the query string and show the top few.
2. **Remote user search (fallback, gated by `userSearch`)**: once the local set is exhausted for a non-empty query, the mention editor debounces (`REMOTE_SEARCH_DEBOUNCE_MS` = 250 ms) and calls the `mentions:search` IPC channel → `connection.searchUsers(query, repo)` → a per-platform user-search endpoint, capped at 20 and appended below the local matches. This lets the user `@mention` people **outside the PR** without knowing the exact username — the gap that a bounded local set alone cannot fill.

Per-platform endpoint choice — **prefer repo-scoped, but only where a normal reviewer can actually call it**:

- **GitLab** — `/projects/:id/users?search=` (project members): repo-scoped and callable by any member. Ideal case.
- **GitHub** — `/repos/{o}/{r}/collaborators` filtered client-side (repo-scoped), but listing collaborators needs **push access**; on 401/403 the adapter falls back to the global `/search/users` (any authenticated user). So scope is "repo collaborators when privileged, else anyone on GitHub".
- **Bitbucket** — `/rest/api/latest/users?permission=LICENSED_USER&filter=`: **the exact endpoint Bitbucket's own web mention picker uses**. Instance-wide (Bitbucket Server's repo `permissions/users` is repo-admin-gated → 401 for reviewers, so a repo-scoped variant isn't usable by normal users); `LICENSED_USER` keeps it to real accounts and it's callable by anyone authenticated.

Any genuine failure (permissions / network / rate limit) degrades to the local menu with **no error surfaced to the user**: the `mentions:search` controller catches it, `console.warn`s for troubleshooting, and returns `[]`.

Both layers are a **pure convenience**: the user can still freely type any `@name` (the platform parses notifications from the text itself), and any remote-search failure silently degrades to the local menu (see the fetch-safety constraint below). The remote query respects a minimum length (2 chars, enforced both in the renderer helper and the main controller), result truncation, debounce, and in-flight cancellation (a stale response is discarded by sequence check).

**Consistency across surfaces (design philosophy)**: every comment-interaction behavior — reactions, `@mention` (local + remote), attachments, reply / edit / delete — must be **identical on all comment surfaces**: the comments/activity page (`CommentItem`), the inline diff comment zone (`InlineCommentZone`), and the inline draft editor (`DraftZone`). This is enforced by **sharing the leaf components / hooks** (`CommentReplyEditor`, `MentionTextarea`, `useReactions`, `useCommentThread`) rather than reimplementing per surface, so a surface can only differ in layout, never in interaction behavior. When adding or changing an interaction, wire it into **all** surfaces (thread the same props down each path) — a capability reaching only one surface is a bug, not a scope choice.

### File-level comments: whole-file anchor + capability degradation

A comment can anchor to a **whole file** (not a specific line) where the platform supports it (`fileLevelComments`). This is modeled by a `PrCommentAnchor` **without a `line`** (path + side only): `anchor == null` → PR summary; `anchor` with a line → inline; `anchor` without a line → file-level. The comment `kind` (`'summary' | 'inline' | 'file'`) mirrors this.

- **Read (all platforms)**: previously a line-less remote anchor was collapsed to a summary, losing its file association (notably Bitbucket, whose web UI creates file comments). Now each adapter maps it to a file-level anchor: Bitbucket (anchor without `line`), GitHub (`subject_type: "file"`). GitLab has no file-level diff-comment concept, so its notes stay summary. File-level comments render in a **strip above the diff editor** for that file (line-based inline zones can't host a line-less anchor), and in the comments/activity list they show a path-only chip (non-clickable — there's no line to jump to).
- **Write (Bitbucket / GitHub)**: a "comment on file" entry in the diff file-comment strip posts via `comments:createFile` → the adapter's inline-publish path with a line-less anchor (Bitbucket sends only path + fileType; GitHub sends `subject_type: "file"`). GitLab's `fileLevelComments` is `false`, so the entry is hidden; the adapter also guards `publishInlineComment` against a line-less anchor defensively.
- **Interaction parity**: the file-comment strip reuses `CommentItem` / `CommentComposer`, so reactions / mention / reply / edit / delete behave identically to every other comment surface (see the consistency rule below). File-level comments are review comments, so reactions use the inline (review) endpoint.

### Image attachments: platform-native upload + reuse of existing rendering

Paste an image → the render layer intercepts → hand the bytes to the adapter via IPC to upload → backfill the platform-returned markdown into the body. Per platform:

- **GitLab**: upload to the project-level `/uploads`, returning `![file](/uploads/<secret>/<file>)`; that relative URL renders via the existing attachment proxy (via the PAT-carrying API download endpoint), with no extra rendering change.
- **Bitbucket**: upload to the repo-level attachments endpoint (multipart field `files`, must carry `X-Atlassian-Token: no-check` to bypass XSRF), using the response's `attachment:<repoId>/<id>`-form markdown; existing rendering already recognizes the `attachment:` protocol.
- **GitHub**: no public attachment upload API (the web end uses an undocumented private endpoint), capability flag false → the render layer doesn't attach a paste-upload entry.

During upload the input box is disabled, to avoid the insertion position drifting when the async backfill lands after the body has been changed.

## 3. Data / interface contract

**Core entities / constants** (only the key shapes are listed; for the complete definitions see the types):

| Entity | Purpose | Shape / key fields |
| --- | --- | --- |
| `PrReaction` | neutral reaction model, hung on `PrComment.reactions?` | `{ emoji, count, mine }` (emoji character as key) |
| `REACTION_PICKER` | `fixed`-mode candidates (shared constant) | a fixed set of 8 emoji characters |
| `REACTION_EMOJIS` | `free`-mode candidates + search source + char ↔ code mapping source (shared curated set) | `{ emoji, code, keywords }[]` (~150 entries) |

**Capability flags**: `commentReactions: false | 'fixed' | 'free'`; `commentAttachments` (boolean); `userSearch` (boolean — remote `@mention` user search).

**Service interfaces** (method name + semantics, no pseudo-signatures):

- `CommentService.toggleReaction`: toggle a given emoji reaction on a given comment (idempotent); `kind` (summary / inline) lets GitHub pick the issue / review reaction endpoint, ignored by other platforms; throws on unsupported platforms.
- `MediaService.uploadAttachment`: upload an image attachment and backfill the markdown — input `CommentAttachmentUpload` (`{ fileName, contentType, bytes }`), returning `CommentAttachmentResult` (`{ markdown }`) or `null` (unsupported).

**IPC channels**:

- `comments:toggleReaction`: toggle a reaction, broadcasting `comments:changed` on success.
- `comments:uploadAttachment`: bytes are transported as an `ArrayBuffer`, which the main side converts to `Uint8Array` and hands to the adapter; it only produces markdown and doesn't touch the comment cache.

**i18n**: the reaction entry goes through `reactions.*`, upload status through `attachments.*`.

## 4. Extension & caveats

- **Adding a new platform**: implement `toggleReaction` / `uploadAttachment`, declare the corresponding capability flags, and provide this platform's "native-name ↔ emoji" mapping; leave unsupported items at their default (reaction throws / upload returns null), and setting the capability flag false hides the whole block.
- **Bitbucket's reaction shape has been verified empirically**: `properties.reactions[].emoticon` gives `shortcut` + `url` (a twemoji SVG whose filename is the Unicode code point, e.g. `1f440.svg`), with no `value` and no `count` field (the count is taken from `users.length`). Display prefers **decoding the emoji from the url code point** (works for any emoji), falling back to the shortcut-name mapping. Emoticon shortcut naming is irregular (e.g. `smile` / `laughing`), so writes (toggle) use the char → shortcode table built from `REACTION_EMOJIS`; when adding a new reaction kind, append a row in that curated set and ensure the shortcode is one the real instance accepts.
- **Reads are always best-effort**: a follow-up query failure of reactions / awards must be caught as "no reaction", and must never bubble up to interrupt the comment list load.
- **@mention does not expand to enumerating everyone**: candidates default to this PR's participants; the `userSearch` remote fallback is query-scoped and carries a minimum query length + result truncation (20) + debounce (250 ms) + in-flight cancellation, so it never full-list-fetches and stays clear of rate limits (GitHub `/search/users` is ~30/min — the debounce keeps well under it).
- **Attachment rendering depends on the existing proxy**: upload only produces markdown, and the authenticated fetch and display of embedded images reuse the existing comment-image proxy; if a new platform adopts a new URL shape, the attachment proxy must be updated to recognize it accordingly.
