# Notifications (system notifications + dock badge)

Extends "relevant to me" events from in-app hints out to the operating-system layer: raises a native system notification (toast) when I am @-mentioned, replied to, or a new PR appears, and shows a "needs response" count badge on the macOS dock icon. See the user-facing guide at [docs/guide/](../../guide/zh-CN/README.md); for the in-list unread mention count see "unread mention count" in [State storage](../99-core/01-state-storage.md).

## Scope

- **System notifications (toast)**: native Windows + macOS notifications, toggled per event type — the review-facing ones (new PR / comment reply / comment @) and the ones for "PRs I created" (new comment / marked needs work / conflict appeared).
- **macOS dock badge**: the total "needs response" count of "@me / replied to me" shown on the dock icon.
- Excludes a persistent status bar / Windows taskbar overlay and flashing (heavy cost, limited benefit).

## Two data paths

### 1. System notifications: poll-event projection → main-process toast

- **Projection (poller)**: `pollOnce` incidentally produces this round's "worth alerting" events `PollNotificationEvent[]` (`kind: new_pr | mention | reply | authored_comment | authored_needs_work | authored_conflict` + PR identity/title + count) during the regular scan, handing them to the main process via the `onNotify` callback. It reuses the existing comment fetch, deciding when to scan per "comment-tracking trigger" below.
  - **new PR**: PRs that are `isAdded`.
  - **@ / reply**: comment scanning uses [`collectMentionsToMe`](../../../packages/poller/src/unread.ts) (classifying by "parent-comment author is me = reply / body @s me = mention", each hit carrying the comment author), taking hits **later than the historical cursor `lastMentionAt`** and aggregating counts by type.
  - **"PRs I created" (author is me, `pr.author` == current user)** — only for these PRs are the following additionally produced:
    - `authored_comment`: others' new comments (using [`collectCommentsFromOthers`](../../../packages/poller/src/unread.ts) to collect all non-self comments, taking those later than the independent cursor `lastCommentAt`; own comments are excluded, so self-comments never misfire).
    - `authored_needs_work`: a newly appearing "needs work" reviewer (in needsWork this round, not in `needsWorkReviewers` last round).
    - `authored_conflict`: merge conflict `hasConflict` false→true.
    - The "last-round snapshot" of the three (`lastCommentAt` / `needsWorkReviewers` / `hasConflict`) is stored on the index entry; when a snapshot field is missing (an old index from before the upgrade), only seed against the baseline, do not back-fire.
  - The event also carries `repo` / `connectionId` / `actor` (the initiator: new_pr = the PR author, mention/reply/authored_comment = the comment author of that type's latest hit, authored_needs_work = the reviewer newly marking needs work, authored_conflict = the PR author).
- **Storm prevention**: events are produced only when **a baseline already exists** (the index was non-empty before this round) — the first round after first launch / a wiped store only builds the baseline, no notification; the historical comments of a newly discovered PR are not projected as mention/reply (skipped when `prev` does not exist).
- **"Pending" only**: events are produced only for PRs with `localStatus === 'pending'` (gated at the projection with `notifiable = hadBaseline && localStatus === 'pending'`) — a PR already approved / marked needs_work is no longer disturbed. "Pending" naturally covers both "Review Requested" (undecided) and "created by me" (the author is not a reviewer → always pending).
- **Click to locate**: mention/reply events carry `comment` (the `remoteId` + `anchor` of the latest hit comment), for click-to-jump.

#### Comment-tracking trigger (when to fetch and scan comments)

Comment scanning is **done only for "pending" (notifiable) PRs** — comment tracking and notification projection share the same scope, and a decided PR is no longer fetched for comments (its unread mention count also stops advancing). Whether to fetch comments is tiered by the platform capability [`commentCountIncludesReplies`](../../../packages/shared/src/platform.ts); the root cause is that platforms expose "comment change" free signals at different granularities:

| Platform | Does `updatedAt` bump with comments? | `commentCount` value | Includes replies? | Trigger strategy |
| --- | --- | --- | --- | --- |
| GitHub | top-level does, inline not necessarily | `comments + review_comments` | ✅ (an inline reply is a review_comment) | scan only when `updatedAt` or `commentCount` changes |
| GitLab | comments (notes) do | `user_notes_count` | ✅ (a reply is also a note) | scan only when `updatedAt` or `commentCount` changes |
| Bitbucket | **never bumps** | `properties.commentCount` (**top-level only**) | ❌ | **fall back to scanning once per round** for pending PRs |

- **Platforms that include replies (`commentCountIncludesReplies=true`)**: the count is a reliable "includes replies" delta signal, so comments are fetched only when either `commentCount` (returned for free with the PR discovery list, no extra request) or `updatedAt` changes — saving requests.
- **Platforms that do not include replies (Bitbucket, `false`)**: `updatedDate` does not bump with comments, and `commentCount` only counts top-level comments (replies excluded), so there is **no free "includes replies" signal at all**; still gating by count/update time would miss "reply"-type notifications (measured: a reply neither bumps `updatedDate` nor enters `commentCount`). Hence for pending PRs, fall back to fetching the comment list once per round and comparing against the cursor — the cost is bounded by the "number of pending PRs" (the polling interval is usually 5 minutes), which is acceptable.
- `commentCount` is mirrored into [`PrIndexEntry`](../../../packages/poller/src/pr-state.ts) for the next round's comparison; when the platform does not provide it, it is undefined and we fall back to deciding by `updatedAt` alone.
- **Landing (main)**: `showPollNotifications` in [`services/notifications.ts`](../../../apps/desktop/src/main/services/notifications.ts) is wired via `onNotify` in `bootstrap/poller.ts`. After filtering by notification config (master switch + per type): at most the first `INDIVIDUAL_LIMIT` (5) are shown one by one (each with a rich avatar style + click-to-locate); the overflow (from the 6th) is collapsed into a single "see more recent activity" hint that, on click, only opens the main UI without locating. Wording goes through main-process i18n (`notifications.*`).
- **Styling**:
  - **Windows** uses the `toastXml` rich style (ToastGeneric): a circular initiator avatar (`appLogoOverride` + `hint-crop="circle"`) + a title line with a type emoji (🔀 PR / 💬 @ / ↩️ reply) + the body `#number title` + an attribution line with the repo `project/repo`. A toast has only one small image slot, so the avatar takes the slot and the type is marked by emoji.
  - **Avatar**: `ensureAvatarFile` in [`services/avatar.ts`](../../../apps/desktop/src/main/services/avatar.ts) reuses an on-disk avatar cache keyed by `(connectionId, slug)` (the same convention as `app:userAvatar`), fetching via the adapter and writing to disk when missing; because a toast `<image src>` needs a local file + a recognizable extension, alongside the raw-byte `.bin` it writes a companion `.png`/`.jpg` per the sniffed content-type. For svg / unknown formats or a failed fetch it degrades to no avatar.
  - **Other platforms**: use `title` / `body` text (the body appends the repo line), without an avatar — on macOS Electron always shows the app icon and does not support per-notification avatars. A failed Windows toastXml build also falls back to this text path.
- **Avatar wiring**: `onNotify` fetches the avatar via `createPoller`'s `getConnectionRuntime` (a lazy getter, since the poller is built before the connection runtime) by taking the adapter for `connectionId`.

### Click navigation

Besides focusing the window, a notification click has the main process push a navigation intent via `broadcast('notification:activate', { localId, kind, anchor })` (`anchor` = an inline comment's `{path,line}`, otherwise null). The renderer (App.tsx subscribing) acts on it: locate the target PR (ignore if not in the active list) → switch back to the active scope + if necessary switch to the discovery category containing it → select it and mark read → then locate by type:

- **new_pr**: only select that PR;
- **inline comment** (anchor non-null): switch to the Diff tab via `pendingDiffNav` and jump to that file line (reusing the finding/draft jump channel);
- **summary comment** (anchor null): switch to the "Activity" chat tab via PrPanel's `pendingTab` (no comment-level precise scroll).

### 2. Dock badge: renderer derives → main process applies

- The renderer's [`useDockBadge`](../../../apps/desktop/src/renderer/src/hooks/useDockBadge.ts) sums the `unreadMentionCount` of the active PR list (each PR is already capped at 10), gated by the notification master switch `enabled` (0 when off; the badge has no independent switch), and pushes it to the main process via `app:setBadgeCount`; [`applyBadgeCount`](../../../apps/desktop/src/main/services/notifications.ts) calls `app.setBadgeCount` on macOS only.
- The count comes from data the renderer has already derived (avoiding the main process re-deriving from the state store), so it lives in a render-layer hook and recomputes as the PR list / config change.

## Config

`config.notifications` ([config.ts](../../../packages/shared/src/config.ts), written via `config:setNotifications`, the settings-page "Notifications" section):

| Field | Meaning |
| --- | --- |
| `enabled` | Master switch; when off, neither system notifications are raised nor the dock badge lit |
| `new_pr` / `reply` / `mention` | Per-type system-notification switches for review-facing events |
| `authored_comment` / `authored_needs_work` / `authored_conflict` | Per-type switches for "PRs I created" (new comment / marked needs work / conflict appeared); on by default |

The macOS dock "needs response" count badge is enabled by default with the master switch, with no independent config item.

## OS permission constraints

- **macOS**: authorization for the first notification is taken over by the system; the app cannot force it on. After a user disables it in "System Settings → Notifications" it can only degrade silently (note that `Notification.isSupported()` only means the platform supports notifications, **not the authorization state** — once disabled the code still calls `show()` and the system discards it, and the main-process Notification API cannot query the authorization state either). Currently the build is ad-hoc signed, not notarized (see [packaging-release](../../development/packaging-release.md)); notifications work but the attribution identity is less reliable than Developer ID + notarization; also, authorization is recorded by bundle id, and the dev build registers as "Electron" while the installed "Code Meeseeks" is a different entry.
  - **Authorization guidance**: on macOS the settings "Notifications" section offers an "Open system notification settings" button (IPC `app:openNotificationSettings`, the main process `shell.openExternal` deep-links to the notifications pane, the pane id falling back per version) for the user to authorize themselves — the app cannot enable it on their behalf.
- **Windows**: the toast relies on `AppUserModelId` (matching the installer's `appId`, set at startup), otherwise it may not show; there is no popup-style authorization. **Click activation calling back into the app** further requires the app to be an installed formal app with a Start Menu shortcut and its AUMID registered in the registry — an unpackaged dev build (`electron-vite dev`) can usually raise a toast but the click cannot activate/route back into the process (JS `click` does not fire), which is an expected limitation; the installed build works normally.
- The dock badge needs no permission.
