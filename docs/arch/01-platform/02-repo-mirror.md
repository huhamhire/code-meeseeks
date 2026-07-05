# Repo mirror & diff

## Responsibilities & boundaries

Mirror the repos involved in a PR to local disk, to serve diff display, blame, and to provide pr-agent with a worktree. All git operations go through `simple-git` + the system `git`.

Responsible for: bare-mirror clone/fetch, worktree materialization, reading files and computing diffs by sha, blame, disk-usage stats. Not responsible for: fetching diffs from the platform REST (not used, platform diffs get truncated), comments (see [Platform adaptation](01-adapter.md)).

## Core design

- **Full bare mirror (`--mirror`)**: one bare mirror per repo, containing **all refs**. The key point is that Bitbucket puts the PR source sha under `refs/pull-requests/<id>/from`, which a plain `--bare` won't pull, causing `git diff base...head` to not find head. We tried a `--filter=blob:none` partial clone early on to save disk, but when blame / pr-agent need a historical blob it triggers on-demand fetching, and when the remote is incomplete it fatals outright — so we reverted to a full clone, leaving the disk cost to the configurable `repos_dir` (see [State storage](../99-core/01-state-storage.md)).
- **First-time clone, incremental fetch thereafter**: fetch uses an explicit refspec to overwrite-pull `refs/heads/*` + `refs/pull-requests/*/from`.
- **Global serial sync queue**: at any moment only one repo is cloning/fetching — multiple callers (PR switch / scheduled) share one queue, so there's no concurrent hammering of the remote, no contention for git bandwidth, and steadier progress; concurrent requests for the same repo reuse the same in-flight Promise. Read operations do not go through the queue.
- **Worktree materialization**: derive an independent repo from the local bare via **`git clone --local --no-checkout`** (same-disk objects go through hardlink, disk cost ~0, and it also works across mount boundaries), then create two internal branches `pr-<localId>/head` / `pr-<localId>/base` pointing at the PR's head/base shas (localId = the stable per-PR primary key, associated with the PR for traceability and carrying no tool-brand prefix; falls back to a random nonce when there is no localId). pr-agent's LocalGitProvider computes the diff on this worktree (see [pr-agent runtime](../02-agent/05-pragent-runtime.md)).
- **Diff does not checkout files**: displaying a diff only needs reading the blob by sha (`git show <sha>:<path>`) + the list of changed files, without checking files out to disk, saving IO. The Monaco side lazy-loads per file, and skips binary / oversized files.
- **Outbound proxy**: clone/fetch that hit the remote inject env per proxy config (see [Networking & proxy](../99-core/03-networking-proxy.md)); local read-only operations do not inject.

## Data / interface contract

- **Mirror path**: `<repos_dir>/<host>/<projectKey>/<repoSlug>/bare`.
- **Main capabilities** (to the main process, by name + semantics): `syncMirror` (create / incremental fetch) · `materializeWorktree` (materialize a worktree by head / base) · `hasCommit` (pre-check whether a fetch is needed) · `listChangedFiles` · `getFileContent` · `getSize` · blame.
- **Progress events**: clone / fetch emit staged `start` / `progress` / `done` / `error`, pushed via IPC to the render layer to show sync progress.

## Extension & caveats

- **`simple-git`'s `.env()` replaces the whole subprocess env**: when injecting proxy env, be sure to merge `process.env`, otherwise you lose `PATH`/`HOME`.
- **LFS**: opt in to allowing unsafe filter only on the worktree instances that need it; keep other read operations in strict mode.
- **After a fresh clone the FS may not be flushed** (especially on Windows): after materializing, wait until git can stably `rev-parse HEAD` a few times before returning, to avoid the immediately following diff hitting refs/packs inconsistency.
- **Disk is the big cost**: repo mirrors are on the GB scale; `repos_dir` can be moved to a large disk; the settings page shows total usage and offers cleanup.
- **Binary files**: diff/read must safely skip non-UTF-8 content (the pr-agent side has corresponding handling too, see [pr-agent runtime](../02-agent/05-pragent-runtime.md)).
