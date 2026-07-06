import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import simpleGit, { type SimpleGit } from 'simple-git';
import type { Logger } from 'pino';
import type { SyncProgressEvent } from '@meebox/shared';
import type {
  BlameLine,
  ChangedFile,
  ChangedFileStatus,
  FileContent,
  MirrorResult,
  RepoIdentity,
  RepoSize,
} from './types.js';

/**
 * simple-git's blockUnsafeOperationsPlugin scans the env object passed to `.env()`; hitting one of these
 * "dangerous" keys (matched lowercase) throws `Use of "X" is not permitted without enabling allowUnsafeXxx`.
 * The list aligns with simple-git v3 env policy. Common host vars EDITOR / PAGER / SSH_ASKPASS / PREFIX are included.
 *
 * When attaching a proxy to remote git we must merge process.env (otherwise PATH/HOME are all lost), but the merge
 * carries these host vars into .env() and triggers the check. For unattended clone/fetch these (editor/pager/askpass/external
 * config paths etc.) are never used, so strip them uniformly at merge time — more robust and complete than enabling allowUnsafe flags one by one.
 */
const GIT_UNSAFE_ENV_KEYS = new Set([
  'editor',
  'git_editor',
  'git_sequence_editor',
  'pager',
  'git_pager',
  'git_askpass',
  'ssh_askpass',
  'git_ssh',
  'git_ssh_command',
  'git_proxy_command',
  'git_external_diff',
  'git_template_dir',
  'git_exec_path',
  'git_config',
  'git_config_global',
  'git_config_system',
  'git_config_count',
  'prefix',
]);

/** Promise version of execFile: for commands where simple-git swallows stdout on non-zero exit (e.g. merge-tree returns exit code 1 on conflict). */
const execFileAsync = promisify(execFile);

/** Strip from env the dangerous keys simple-git blocks (case-insensitive). */
function stripGitUnsafeEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!GIT_UNSAFE_ENV_KEYS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

export interface RepoMirrorOptions {
  /** repos_dir root (from config.workspace.repos_dir, ~ already expanded) */
  reposDir: string;
  /** Provided by PlatformAdapter: returns an authenticated clone URL for a repo */
  getCloneUrl: (repo: RepoIdentity) => Promise<string>;
  logger?: Logger;
  /** Optional sync progress callback; emits start/progress/done/error in phases during clone/fetch */
  onProgress?: (event: SyncProgressEvent) => void;
  /**
   * Optional outbound proxy env. Getter form, evaluated before each remote clone/fetch,
   * so a proxy change in the settings page takes effect on the next operation. Returns HTTP(S)_PROXY/NO_PROXY etc.; returns {} when disabled.
   * Applies only to clone/fetch that hit the remote; local read-only git operations are not injected.
   */
  proxyEnv?: () => Record<string, string>;
}

/**
 * Local git mirror management. **Global** sync queue: at most 1 repo is cloning/fetching at any time.
 * Multiple callers (UI switching PRs / main-process schedule) share this queue, so Bitbucket is not hit
 * concurrently and git-process bandwidth is not contended — the progress the user perceives is steadier.
 *
 * Read operations (listChangedFiles / getFileContent / getSize) skip the queue; concurrent read-only
 * access to the local bare mirror is safe.
 *
 * Strategy: `git clone --bare` (full bare mirror, including all blobs). Early on we used
 * `--filter=blob:none` partial clone to save disk, but `git blame --porcelain` triggers
 * on-demand fetching of the full history's blobs; in M2-D testing it was either slow or, when the remote
 * was incomplete, exited fatal outright. To let blame / pr-agent and similar tools that need history blobs run
 * stably, we reverted to a full bare clone, leaving the disk-usage cost to the user's visible total in the
 * settings page + a switchable `repos_dir`.
 *
 * Subsequent fetches go through `git fetch`, incremental.
 *
 * No worktree. Within the M2 scope, diff computation uses `git show <sha>:<path>`, with no need to
 * check out files to disk. When wiring up pr-agent in M3 we will revisit whether a worktree is needed.
 */
export class RepoMirrorManager {
  /** Global single-queue pointer; each new syncMirror chains onto its tail and runs serially. */
  private syncQueue: Promise<unknown> = Promise.resolve();
  /** Indexes running (or queued) sync Promises by repoKey; concurrent calls for the same repo reuse it. */
  private readonly inFlight = new Map<string, Promise<MirrorResult>>();

  constructor(private readonly opts: RepoMirrorOptions) {}

  /**
   * Attach proxy env to a simple-git instance that hits the remote. Returns as-is when the proxy is
   * disabled / unconfigured (the git subprocess inherits process.env). Note simple-git's .env() replaces the
   * subprocess env wholesale, so process.env must be merged, otherwise PATH / HOME etc. are all lost.
   */
  private withProxyEnv(git: SimpleGit): SimpleGit {
    const px = this.opts.proxyEnv?.() ?? {};
    if (Object.keys(px).length === 0) return git;
    // Strip host EDITOR/PAGER/SSH_ASKPASS etc.: simple-git's safety plugin intercepts these keys passed to
    // .env() and throws errors like allowUnsafeEditor (see the GIT_UNSAFE_ENV_KEYS comment).
    const merged = stripGitUnsafeEnv({ ...process.env, ...px } as Record<string, string>);
    return git.env(merged);
  }

  /** Compute where the bare mirror should live (existence not guaranteed). */
  mirrorPath(repo: RepoIdentity): string {
    return path.join(this.opts.reposDir, repo.host, repo.projectKey, repo.repoSlug, 'bare');
  }

  /**
   * Check whether the given commit sha is reachable in the local bare mirror. Used as a precheck for
   * "when opening a PR, skip the fetch if the local mirror already contains head + base sha" (saving a network round-trip).
   *
   * Implementation: `git cat-file -e <sha>^{commit}` — verifies only existence and that it really is a commit
   * type (not tree/blob); hit is exit 0, missing is exit non-0. Lighter than `rev-parse`
   * (does not resolve reflog / refs) and more precise than `log -1` (the latter can "see" some objects even when the remote is incomplete).
   *
   * Mirror directory missing → false directly (not yet cloned). git error → treated as false (conservative).
   */
  async hasCommit(repo: RepoIdentity, sha: string): Promise<boolean> {
    if (!sha) return false;
    const mp = this.mirrorPath(repo);
    try {
      await fs.access(mp);
    } catch {
      return false;
    }
    try {
      await simpleGit(mp).raw(['cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Best-effort fetch of the given refspec into the bare mirror (typical use: pull in a platform PR head ref
   * `refs/pull/<n>/head` etc., pinning back the PR head sha of a deleted / force-pushed source branch — `refs/heads/*` no longer sees it).
   * Neither a missing mirror nor a fetch failure **throws** (network / remote rejection / that PR ref not existing are all possible); the caller re-verifies
   * with hasCommit afterward. Empty refspec returns directly. Precondition: the caller has already awaited syncMirror, so there is no concurrency with the global sync queue.
   */
  async fetchRefspecs(repo: RepoIdentity, refspecs: string[]): Promise<void> {
    if (refspecs.length === 0) return;
    const mp = this.mirrorPath(repo);
    try {
      await fs.access(mp);
    } catch {
      return;
    }
    try {
      // Fetch by a freshly re-assembled authenticated URL (not the stored origin), so a rotated token applies
      // here too — origin may still carry a historical/stale token on older mirrors.
      const url = await this.opts.getCloneUrl(repo);
      await this.withProxyEnv(simpleGit({ baseDir: mp })).raw(['fetch', url, ...refspecs]);
    } catch (err) {
      this.opts.logger?.debug(
        {
          err: err instanceof Error ? err.message : String(err),
          repo: this.repoKey(repo),
          refspecs,
        },
        'fetchRefspecs failed (best-effort); sha may still be unreachable',
      );
    }
  }

  /**
   * Whether the mirror is "healthy": a valid git directory with origin remote configured. A clone/fetch interrupted midway leaves a directory where "HEAD exists
   * but git metadata is incomplete (origin remote often missing)"; checking only that HEAD exists wrongly assumes it can fetch → `git fetch origin`
   * goes fatal outright (`'origin' does not appear to be a git repository`). Using `git config --get
   * remote.origin.url` verifies both at once: the command fails in a non-git directory, and with origin unconfigured there is no output → failing either means unhealthy,
   * on which the caller deletes and rebuilds the repo (see doSyncMirror's proactive self-heal).
   */
  private async isHealthyMirror(mirrorPath: string): Promise<boolean> {
    try {
      const url = await simpleGit(mirrorPath).raw(['config', '--get', 'remote.origin.url']);
      return url.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Count the "source-branch mainline self-produced" commits between base..head (the number of commits the PR introduces). Runs entirely on the local bare mirror
   * `git rev-list --count --first-parent --no-merges <base>..<head>` — no remote, returns in milliseconds.
   *
   * Use: the UI shows a commits-count badge on the PR tab without hitting the remote just for a number. When base is the **fork-point sha**
   * (merge-base), base..head = the commits the source branch introduces since forking; `--first-parent` follows only the source-branch mainline, excluding
   * others' commits brought in by historical merges of other branches, and `--no-merges` further omits the merge commits themselves — the same criterion
   * as {@link listIntroducedCommitShas} (the filter set for the commit list / activity timeline), avoiding a mismatch between the badge and the list.
   *
   * If either sha is not in the local mirror (not yet synced to this PR's range) → returns null, and the caller treats it
   * as "temporarily unknown" (no badge / shows a loading placeholder).
   */
  async countCommits(repo: RepoIdentity, baseSha: string, headSha: string): Promise<number | null> {
    const shas = await this.listIntroducedCommitShas(repo, baseSha, headSha);
    return shas === null ? null : shas.length;
  }

  /**
   * List the "source-branch mainline self-produced" commit SHAs (40-char) between base..head, newest-first. Runs entirely on the local bare
   * mirror `git rev-list --first-parent --no-merges <base>..<head>` — no remote.
   *
   * `--first-parent` traverses only the source-branch mainline: **others' commits** brought in by historically merging other branches into the source branch (landing on
   * the merge commit's second-parent side) do not enter the result; `--no-merges` further removes the merge commits themselves. What remains is only the commits produced directly
   * on the source branch.
   *
   * Use: filter the full list returned by the platform `/commits` endpoint (the whole `target..source` set, including merges and merged-in others' commits)
   * down to "the commits this PR truly introduces", eliminating the list noise caused by long-lived branches / fork-sync branches repeatedly merging.
   *
   * If either sha is not in the local mirror (not yet synced to this PR's range) → returns null, and the caller falls back to the unfiltered platform list.
   */
  async listIntroducedCommitShas(
    repo: RepoIdentity,
    baseSha: string,
    headSha: string,
  ): Promise<string[] | null> {
    if (!baseSha || !headSha) return null;
    const [hasBase, hasHead] = await Promise.all([
      this.hasCommit(repo, baseSha),
      this.hasCommit(repo, headSha),
    ]);
    if (!hasBase || !hasHead) return null;
    const mp = this.mirrorPath(repo);
    try {
      const out = await simpleGit(mp).raw([
        'rev-list',
        '--first-parent',
        '--no-merges',
        `${baseSha}..${headSha}`,
      ]);
      return out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } catch {
      return null;
    }
  }

  /**
   * `git merge-base a b` — the nearest common ancestor of two shas (where the PR source branch forked from the target).
   * Used to anchor the PR diff's base to the fork point (rather than the target-branch tip that moves forward as other PRs merge).
   * If either sha is missing / there is no common ancestor / an object is missing → returns null, and the caller falls back (does not persist it, retries next time).
   */
  async mergeBase(repo: RepoIdentity, a: string, b: string): Promise<string | null> {
    if (!a || !b) return null;
    const mp = this.mirrorPath(repo);
    try {
      const out = await simpleGit(mp).raw(['merge-base', a, b]);
      const sha = out.trim();
      return sha || null;
    } catch {
      return null;
    }
  }

  /**
   * `git merge-base --is-ancestor anc desc` — whether anc is an ancestor of desc.
   * Used to validate that a persisted base is still valid for the current head (still holds under normal head push; broken after a rebase → triggers recomputation).
   * exit 0 → true; exit 1 (not an ancestor) / missing object → false.
   */
  async isAncestor(repo: RepoIdentity, anc: string, desc: string): Promise<boolean> {
    if (!anc || !desc) return false;
    const mp = this.mirrorPath(repo);
    try {
      await simpleGit(mp).raw(['merge-base', '--is-ancestor', anc, desc]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sync the mirror: bare partial clone on first run, fetch thereafter.
   *
   * Scheduling rules:
   * - Concurrent calls for the same repo → reuse the same in-flight Promise (no duplicate sync, shared progress)
   * - Different repos serialize: every new sync chains onto the global queue's tail, at most 1 running at any time
   *
   * Progress is emitted via the onProgress callback; when multiple callers share the same sync, each of their
   * subscribers receives the same set of events.
   */
  async syncMirror(repo: RepoIdentity): Promise<MirrorResult> {
    const key = this.repoKey(repo);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const run = (): Promise<MirrorResult> => this.doSyncMirror(repo);
    // Run regardless of prev's success/failure, to avoid one failure blocking the rest of the queue
    const promise = this.syncQueue.then(run, run);
    this.inFlight.set(key, promise);
    // Push the queue-tail pointer to next (use catch to flatten failure to undefined, ensuring the next .then's
    // onFulfilled is called); what is awaited is still the original promise, getting the real result/exception
    this.syncQueue = promise.catch(() => undefined);

    // After sync completes / fails, remove it from in-flight so the next call can start a new sync.
    // catch the rejection first (to avoid throwing an unhandled rejection on the finally chain);
    // the caller awaiting the original promise still gets the real reject.
    promise
      .catch(() => undefined)
      .finally(() => {
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
        }
      });

    return promise;
  }

  /**
   * Derive a **self-contained** temporary worktree from the bare mirror, with HEAD on the named branch `pr-<localId>/head`
   * pointing at headSha; optionally also create `pr-<localId>/base` pointing at baseSha.
   *
   * Why this is needed: pr-agent community edition's `LocalGitProvider.__init__` does two strongly-constrained things:
   *   - `self.head_branch_name = self.repo.head.ref.name` — HEAD must be on a named branch
   *     (cannot be detached), otherwise GitPython throws TypeError
   *   - `LOCAL__TARGET_BRANCH` must be a **branch name** that exists in `self.repo.heads`
   *     (does not accept a sha), otherwise `branches[target_name]` KeyError
   * The branch name uses `pr-<localId>/<head|base>` (localId = per-PR stable primary key): associated with the PR for traceability,
   * while avoiding collisions with the repo's real branches; no tool brand prefix, leaving no fixed identifiable trait. When localId
   * is not provided (direct package-level calls) it falls back to this run's random nonce, staying different each time.
   *
   * Why not `git worktree add`: a worktree's `.git` is a file whose content is
   *   `gitdir: <bare-host-path>/worktrees/<name>`
   * depending on an external host absolute path; once the bare repo is moved / cleaned up the chain breaks, GitPython cannot find the
   * git dir → throws `Could not find repository root`.
   *
   * Implementation: `git clone --local --no-checkout` derives an independent repo from the bare one — on the same disk
   * objects go through hardlinks, disk ~0; the .git is self-contained, does not depend on external paths, more robust. Then fetch
   * Bitbucket's dedicated refspec `refs/pull-requests/<id>/from` to bring the PR source sha in sync (the default
   * refspec does not fetch it, otherwise checkout fails after the PR source branch is deleted / force-pushed).
   *
   * Returns `{ path, headBranchName, targetBranchName?, cleanup }`:
   *   - `headBranchName`: the branch name HEAD is currently on (`pr-<localId>/head`), which the caller usually
   *     does not need but is kept for interface symmetry
   *   - `targetBranchName`: only present when baseSha is passed, filled into pr-agent `LOCAL__TARGET_BRANCH`
   *   - `cleanup()`: clean up the temporary directory
   *
   * Naming: `<reposDir>/<repo>/wt/<sha12>-<ts>-<rand>`, concurrency-safe via timestamp + random suffix.
   */
  async materializeWorktree(
    repo: RepoIdentity,
    headSha: string,
    baseSha?: string,
    prLocalId?: string,
  ): Promise<{
    path: string;
    headBranchName: string;
    targetBranchName?: string;
    cleanup: () => Promise<void>;
  }> {
    const mirrorPath = this.mirrorPath(repo);
    const wtRoot = path.join(this.opts.reposDir, repo.host, repo.projectKey, repo.repoSlug, 'wt');
    await fs.mkdir(wtRoot, { recursive: true });
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const wtPath = path.join(wtRoot, `${headSha.slice(0, 12)}-${nonce}`);

    // Branch name associated with the PR (localId = per-PR stable primary key) for traceability, no tool brand prefix; when localId
    // is absent (direct package-level calls) fall back to this run's random nonce. Use `<ns>/head`, `<ns>/base` hierarchical naming (matching platform
    // PR ref conventions like refs/pull/N/head); no bare `<ns>` branch is created separately, so there is no git dir/file ref collision.
    const branchNs = prLocalId ? `pr-${prLocalId}` : `pr-${nonce}`;
    const HEAD_BRANCH = `${branchNs}/head`;
    const BASE_BRANCH = `${branchNs}/base`;

    // --local + default hardlinks: same-disk inode sharing, no alternates file (avoids cross-mount chain breakage)
    // --no-checkout: do not lay down files yet, checkout after the branch is created
    await simpleGit(wtRoot).clone(mirrorPath, wtPath, ['--local', '--no-checkout']);

    // Disable the LFS smudge filter: the bare mirror does not fetch LFS objects by default (--mirror fetches only git refs),
    // and containers usually cannot reach the enterprise intranet LFS server either. Keep the LFS pointer as-is (a few-hundred-byte
    // pointer text), otherwise `git checkout` calls git-lfs to fetch the real blob from the remote, smudge fails
    // → exit. pr-agent reviewing a binary file is meaningless; seeing the pointer text is just a small bit of metadata.
    //   - filter.lfs.smudge=cat: cat the file directly on smudge (does not call git-lfs)
    //   - filter.lfs.process=empty: clear the long-lived filter process (default git-lfs filter-process)
    //   - filter.lfs.required=false: a missing / failing filter is not treated as a fatal error
    // The config persists in .git/config; the pr-agent container inherits the same config, so it naturally does not trigger LFS either.
    //
    // simple-git forbids setting filter.* by default (fear of arbitrary command injection); explicit allowUnsafeFilter
    // opts in only on this simpleGit instance, while other read operations use the default strict mode
    const lfsCfg = simpleGit({ baseDir: wtPath, unsafe: { allowUnsafeFilter: true } });
    await lfsCfg.raw(['config', '--local', 'filter.lfs.smudge', 'cat']);
    await lfsCfg.raw(['config', '--local', 'filter.lfs.process', '']);
    await lfsCfg.raw(['config', '--local', 'filter.lfs.required', 'false']);

    // Pull in Bitbucket's PR source sha: `git clone` fetches only refs/heads/* by default. Failure does not block
    // (finding headSha in heads is also fine, e.g. a GitHub fork)
    try {
      await simpleGit(wtPath).raw([
        'fetch',
        mirrorPath,
        '+refs/pull-requests/*/from:refs/pull-requests/*/from',
      ]);
    } catch (err) {
      this.opts.logger?.debug(
        { err, wtPath },
        'pull-requests refspec fetch failed; head may still be reachable via heads',
      );
    }

    // Create named branch meebox/head pointing at headSha and checkout (pr-agent requires HEAD on a named branch)
    await simpleGit(wtPath).raw(['checkout', '-b', HEAD_BRANCH, headSha]);

    // When baseSha is provided, create meebox/base pointing at it (pr-agent LOCAL__TARGET_BRANCH only accepts a branch name)
    let targetBranchName: string | undefined;
    if (baseSha) {
      await simpleGit(wtPath).raw(['branch', '-f', BASE_BRANCH, baseSha]);
      targetBranchName = BASE_BRANCH;
    }

    this.opts.logger?.debug(
      { repo: this.repoKey(repo), headSha, baseSha, wtPath, targetBranchName },
      'materialized worktree (self-contained clone)',
    );
    return {
      path: wtPath,
      headBranchName: HEAD_BRANCH,
      targetBranchName,
      cleanup: async () => {
        // Self-contained clone, no bare-side registration to clean up, just rm -rf
        await fs.rm(wtPath, { recursive: true, force: true }).catch((err) => {
          this.opts.logger?.warn({ err, wtPath }, 'worktree cleanup failed');
        });
      },
    };
  }

  /** Mirror size (bytes). Returns 0 if it does not exist. */
  async getSize(repo: RepoIdentity): Promise<RepoSize> {
    const dir = this.mirrorPath(repo);
    if (!(await this.exists(dir))) return { totalBytes: 0 };
    return { totalBytes: await this.dirSize(dir) };
  }

  /**
   * List files changed within the PR range (three-dot diff of baseSha and headSha, consistent with Bitbucket/GitHub
   * PR diffs: the changes head introduces since forking).
   *
   * Use -z to NUL-separate status + path, so paths with spaces/Chinese / quotes do not break.
   */
  async listChangedFiles(
    repo: RepoIdentity,
    baseSha: string,
    headSha: string,
  ): Promise<ChangedFile[]> {
    const mirrorPath = this.mirrorPath(repo);
    // Right after clone / fetch, pack files may still be flushing to the FS; on the first cat of some shas
    // git may briefly report 'Invalid symmetric difference' / 'bad revision'. A simple retry
    // twice, at 200ms / 400ms intervals, usually stabilizes it. Failing again propagates up for the renderer to show a banner.
    const out = await retryTransientGit(
      () => simpleGit(mirrorPath).raw(['diff', '-z', '--name-status', `${baseSha}...${headSha}`]),
      this.opts.logger,
      { op: 'listChangedFiles', repo: this.repoKey(repo), baseSha, headSha },
    );
    return parseNameStatusZ(out);
  }

  /**
   * List the file paths that would conflict when merging source head into target tip (a trial merge via `git merge-tree --write-tree`, git ≥ 2.38).
   * No conflict (exit code 0) / undeterminable (exit code < 0 or git too old) → returns an empty array, and the caller conservatively does not mark.
   *
   * On conflict merge-tree returns exit code 1 and writes the result to stdout; simple-git swallows stdout on non-zero exit, so go straight through
   * execFile to capture stdout ourselves. `-z` makes the output NUL-separated (paths with spaces/Chinese/quotes do not break), `--name-only` outputs only the conflicting
   * file names: the first field is the result tree OID, followed by each conflicting file name; hitting an empty field (the double NUL between segments) ends the conflict-file segment.
   */
  async listConflictFiles(
    repo: RepoIdentity,
    targetSha: string,
    sourceSha: string,
  ): Promise<string[]> {
    if (!targetSha || !sourceSha) return [];
    const mirrorPath = this.mirrorPath(repo);
    try {
      // Exit code 0 = clean, mergeable, no conflict.
      await execFileAsync(
        'git',
        ['merge-tree', '--write-tree', '--name-only', '-z', targetSha, sourceSha],
        { cwd: mirrorPath, maxBuffer: 64 * 1024 * 1024 },
      );
      return [];
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string | Buffer };
      // Exit code 1 = conflict exists, stdout carries the conflict-file segment; otherwise (trial merge could not complete / git too old) conservatively return empty.
      if (e.code === 1 && e.stdout != null) {
        return parseMergeTreeConflictsZ(e.stdout.toString());
      }
      this.opts.logger?.warn(
        { err, repo: this.repoKey(repo), targetSha, sourceSha },
        'git merge-tree conflict probe failed; treating as no conflict',
      );
      return [];
    }
  }

  /**
   * Read a file's content at a given commit. Under a full bare clone all blobs are local, so git show directly.
   * If the file is not in that commit (add/delete scenarios) returns empty content.
   * Simple null-byte heuristic to detect binary (first 8000 characters).
   */
  async getFileContent(repo: RepoIdentity, sha: string, filePath: string): Promise<FileContent> {
    const mirrorPath = this.mirrorPath(repo);
    let content: string;
    try {
      content = await simpleGit(mirrorPath).raw(['show', `${sha}:${filePath}`]);
    } catch {
      // File does not exist at that commit (before an add / after a delete), return empty
      return { binary: false, content: '' };
    }
    if (content.slice(0, 8000).includes(' ')) {
      return { binary: true };
    }
    return { binary: false, content };
  }

  /**
   * List the set of line numbers added / modified on the head side within the PR (`baseSha...headSha`).
   * Used for blame filtering: lines the PR itself introduces do not show historical blame (semantically meaningless, would only point to
   * the PR's own commit); original attribution is shown only for the part already present in base.
   *
   * Uses `git diff -U0 base...head -- path`, parsing the right side C..C+D-1 segment of the hunk header
   * `@@ -A,B +C,D @@`. D=0 (pure deletion) contributes no head lines.
   */
  async listChangedHeadLines(
    repo: RepoIdentity,
    baseSha: string,
    headSha: string,
    filePath: string,
  ): Promise<Set<number>> {
    const mirrorPath = this.mirrorPath(repo);
    let out: string;
    try {
      out = await simpleGit(mirrorPath).raw([
        'diff',
        '-U0',
        '--no-color',
        `${baseSha}...${headSha}`,
        '--',
        filePath,
      ]);
    } catch (err) {
      this.opts.logger?.warn(
        { err, repo: this.repoKey(repo), baseSha, headSha, filePath },
        'git diff for changed lines failed',
      );
      // On failure conservatively return an empty set → blame shows everything; at least no info is lost
      return new Set();
    }
    return parseHunkAddedLines(out);
  }

  /**
   * Run `git blame --porcelain <sha> -- <path>` and parse each line's attribution commit + author + time.
   * Under a full bare clone all history blobs are local, so it should normally return in seconds.
   *
   * Error handling has two tiers:
   *   - **`fatal: no such path X in <sha>`**: the file does not exist at that sha (the PR deleted it /
   *     renamed it / a later commit reverted it to its original state). This is a legal state, blame naturally does not exist, so
   *     return an empty array to let the renderer "leave blame empty" rather than pop an error banner.
   *   - Other errors: thrown so the renderer shows a BackendErrorBanner, with the raw git stderr attached.
   */
  async getBlame(repo: RepoIdentity, sha: string, filePath: string): Promise<BlameLine[]> {
    const mirrorPath = this.mirrorPath(repo);
    try {
      const out = await simpleGit(mirrorPath).raw(['blame', '--porcelain', sha, '--', filePath]);
      return parseBlamePorcelain(out);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no such path/i.test(msg)) {
        this.opts.logger?.debug(
          { repo: this.repoKey(repo), sha, filePath },
          'git blame: path not in sha; returning empty blame',
        );
        return [];
      }
      this.opts.logger?.warn({ err, repo: this.repoKey(repo), sha, filePath }, 'git blame failed');
      throw err;
    }
  }

  private async doSyncMirror(repo: RepoIdentity): Promise<MirrorResult> {
    const mirrorPath = this.mirrorPath(repo);
    const key = this.repoKey(repo);
    let hasMirror = await this.exists(path.join(mirrorPath, 'HEAD'));
    // Self-heal (proactive): directory exists but is not a **healthy** mirror — a clone/fetch interrupted midway leaves an incomplete mirror where "HEAD exists but origin
    // remote is missing / not a valid git directory", after which `git fetch origin` goes fatal outright
    // (`'origin' does not appear to be a git repository`). Detect and delete it, then do a full rebuild as a first-time clone.
    if (hasMirror && !(await this.isHealthyMirror(mirrorPath))) {
      this.opts.logger?.warn(
        { repo: key, mirrorPath },
        'unhealthy mirror detected (interrupted clone?); removing for full re-clone',
      );
      await fs.rm(mirrorPath, { recursive: true, force: true }).catch(() => undefined);
      hasMirror = false;
    }

    const emit = (e: Omit<SyncProgressEvent, 'repo'>): void => {
      this.opts.onProgress?.({ repo: key, ...e });
    };
    // simple-git parses git --progress's stderr into { method, stage, progress } and pushes it to us
    const gitProgressOpt = {
      progress: ({
        method,
        stage,
        progress,
      }: {
        method: string;
        stage: string;
        progress: number;
      }): void => {
        emit({ phase: 'progress', stage, percent: progress, message: `${method} ${stage}` });
      },
    };

    emit({ phase: 'start', message: hasMirror ? 'fetching' : 'cloning' });

    try {
      if (hasMirror) {
        try {
          this.opts.logger?.debug({ repo: key }, 'mirror exists, fetching');
          // Re-assemble the authenticated URL fresh every sync and fetch by explicit URL rather than via the
          // stored `origin` remote: a rotated token then takes effect immediately. Historically the token was
          // baked into remote.origin.url at clone time, so after a PAT rotation an existing mirror kept fetching
          // with the stale token → `fatal: Authentication failed` until the cache dir was cleared.
          const url = await this.opts.getCloneUrl(repo);
          // Best-effort: rewrite origin to the credential-free URL. Strips a token any historically-cached mirror
          // baked in (security), and normalizes origin for the health check; the fetch below does not depend on it.
          await simpleGit({ baseDir: mirrorPath })
            .raw(['remote', 'set-url', 'origin', stripGitCredentials(url)])
            .catch(() => undefined);
          // Explicit refspec, force-overwrite fetch:
          //   - refs/heads/*: all branches (including the PR target and source branches)
          //   - refs/pull-requests/*/from: Bitbucket stores the PR source sha separately here.
          //     After the source branch is deleted / force-pushed, refs/heads no longer sees it, but the from ref still points at
          //     the sha at PR-open time; without it `git diff base...head` gives "Invalid
          //     symmetric difference" because head is unreachable.
          await this.withProxyEnv(simpleGit({ baseDir: mirrorPath, ...gitProgressOpt })).raw([
            'fetch',
            '--progress',
            url,
            '+refs/heads/*:refs/heads/*',
            '+refs/pull-requests/*/from:refs/pull-requests/*/from',
          ]);
          emit({ phase: 'done' });
          return { mirrorPath, freshClone: false };
        } catch (fetchErr) {
          // Self-heal (reactive): fetch hits a **locally corrupt / incomplete** mirror (missing origin, bad objects, etc.) → delete it, falling to the full
          // clone rebuild below. Other errors (network / auth / remote rejection) are thrown as-is, not mistakenly deleting a healthy mirror, not treating a transient network issue as corruption.
          if (!isLocalMirrorCorruption(fetchErr)) throw fetchErr;
          this.opts.logger?.warn(
            { repo: key, err: fetchErr instanceof Error ? fetchErr.message : String(fetchErr) },
            'fetch failed on corrupt mirror; removing for full re-clone',
          );
          await fs.rm(mirrorPath, { recursive: true, force: true }).catch(() => undefined);
          // Do not return; fall to the full clone self-heal rebuild below.
        }
      }

      this.opts.logger?.info({ repo: key }, 'cloning bare mirror (full + all refs)');
      const url = await this.opts.getCloneUrl(repo);
      await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
      // --mirror instead of --bare: default --bare fetches only refs/heads + refs/tags,
      //   but Bitbucket's PR source sha lands in the refs/pull-requests/<id>/from namespace,
      //   and if not fetched `git diff base...head` cannot find the head sha → "Invalid
      //   symmetric difference". --mirror implies --bare and fetches all refs
      //   (heads/tags/pull-requests/notes/...), and subsequent fetches also sync everything automatically.
      // --no-hardlinks: the local upstream should not reuse hardlinks, avoiding state crosstalk with upstream
      //   during fetch; remote HTTPS clone is unaffected.
      // --progress: force git to output progress, otherwise non-TTY mode is silent by default
      //
      // No --filter=blob:none: tools that need history blobs like blame / pr-agent would trigger
      //   on-demand fetching, going fatal outright when the remote is incomplete or the partial-clone protocol is unsupported. A full clone
      //   pays the disk cost once and is stable at runtime.
      await this.withProxyEnv(simpleGit(gitProgressOpt)).clone(url, mirrorPath, [
        '--mirror',
        '--no-hardlinks',
        '--progress',
      ]);
      // Never persist the token: `git clone` writes the authenticated URL into remote.origin.url, so immediately
      // rewrite origin to the credential-free form. Subsequent fetches re-assemble the authenticated URL fresh
      // (see the fetch path above), so a later token rotation needs no cache clear. Best-effort — a failure here
      // doesn't invalidate the freshly-cloned mirror.
      await simpleGit({ baseDir: mirrorPath })
        .raw(['remote', 'set-url', 'origin', stripGitCredentials(url)])
        .catch(() => undefined);
      // On systems like Windows the FS may still be flushing after a fresh clone, and the immediately following git diff
      // can hit a "refs/packs state inconsistent" error. Wait until git itself can rev-parse HEAD
      // stably a few times before returning, so the mirror the caller receives is guaranteed usable.
      await waitMirrorReady(mirrorPath, this.opts.logger);
      emit({ phase: 'done' });
      return { mirrorPath, freshClone: true };
    } catch (err) {
      emit({
        phase: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private repoKey(repo: RepoIdentity): string {
    return `${repo.host}/${repo.projectKey}/${repo.repoSlug}`;
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async dirSize(dir: string): Promise<number> {
    let total = 0;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await this.dirSize(full);
      } else if (entry.isFile()) {
        total += (await fs.stat(full)).size;
      }
    }
    return total;
  }
}

/**
 * Strip any embedded credentials from a git remote URL. The authenticated clone URL carries the PAT
 * (`https://<user>:<token>@host/...`); we never want that token persisted into the mirror's `.git/config`
 * (a plaintext-secret / security concern) nor baked into `remote.origin.url` where it goes stale on the next
 * token rotation (the historical "Authentication failed until you clear the cache" bug). Instead the
 * authenticated URL is re-assembled fresh (from configured repo + upstream) for each remote op, and only this
 * credential-free form is stored. scp-like SSH remotes (`git@host:proj/repo.git`) aren't valid URL() inputs and
 * carry no embedded token, so they're returned unchanged.
 */
export function stripGitCredentials(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Whether the error message points to a **locally corrupt / incomplete mirror** (rather than a retryable remote issue like network / auth / remote rejection). After a fetch failure
 * this decides whether to "delete and re-clone" as a self-heal — self-heal only on local corruption, avoiding a pointless full rebuild from misjudging a transient network issue as corruption.
 * Does not match "could not read from remote repository": it also appears on network / auth failures, so it cannot be used to judge local corruption.
 */
function isLocalMirrorCorruption(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('does not appear to be a git repository') || // missing origin remote (interrupted clone)
    msg.includes('not a git repository') ||
    msg.includes('bad object') ||
    msg.includes('object file is empty') ||
    msg.includes('loose object') || // "loose object <sha> is corrupt"
    msg.includes('did not send all necessary objects') ||
    msg.includes('unable to read')
  );
}

/**
 * Stability fallback after a fresh clone: poll `git rev-parse HEAD` until it succeeds, up to ~5 times totaling
 * 500ms. The Windows filesystem / antivirus may cause a brief delay in pack writes; this function moves that
 * wait from the caller into the mirror itself.
 */
async function waitMirrorReady(mirrorPath: string, logger?: Logger): Promise<void> {
  const tries = [40, 80, 120, 200, 320];
  for (const delay of tries) {
    try {
      await simpleGit(mirrorPath).raw(['rev-parse', '--verify', 'HEAD']);
      return;
    } catch {
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
  logger?.warn({ mirrorPath }, 'mirror not ready after settle window; proceeding anyway');
}

/**
 * Wrap a git call in a retry layer: if the error message matches the "mirror just cloned but not yet ready" family (Invalid
 * symmetric difference / bad revision / unknown revision), sleep a bit and try
 * again, up to 3 times (including the first). Other errors (network / no such path / the real sha
 * not existing) are thrown immediately, wasting no time.
 */
const TRANSIENT_GIT_RE =
  /Invalid symmetric difference expression|bad revision|unknown revision or path not in the working tree/i;

async function retryTransientGit<T>(
  op: () => Promise<T>,
  logger?: Logger,
  ctx?: Record<string, unknown>,
): Promise<T> {
  const delays = [200, 400];
  let lastErr: unknown;
  try {
    return await op();
  } catch (err) {
    lastErr = err;
  }
  for (const delay of delays) {
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    if (!TRANSIENT_GIT_RE.test(msg)) throw lastErr;
    logger?.debug({ ...ctx, delay }, 'transient git error; retrying after settle');
    await new Promise<void>((r) => setTimeout(r, delay));
    try {
      return await op();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Parse the output of `git diff -z --name-status A...B`.
 * Format (NUL-separated):
 *   M\0path\0M\0path\0
 *   A\0newpath\0
 *   D\0oldpath\0
 *   R100\0oldpath\0newpath\0
 *   C75\0srcpath\0dstpath\0
 */
function parseNameStatusZ(raw: string): ChangedFile[] {
  const tokens = raw.split(' ').filter((t) => t.length > 0);
  const out: ChangedFile[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i]!;
    const letter = code[0]!;
    const similarity = code.length > 1 ? Number.parseInt(code.slice(1), 10) : undefined;
    const status = mapStatusLetter(letter);
    if (status === 'renamed' || status === 'copied') {
      const oldPath = tokens[i + 1];
      const path = tokens[i + 2];
      if (oldPath !== undefined && path !== undefined) {
        out.push({ path, oldPath, status, similarity });
      }
      i += 3;
    } else {
      const path = tokens[i + 1];
      if (path !== undefined) out.push({ path, status });
      i += 2;
    }
  }
  return out;
}

/**
 * Parse the stdout of `git merge-tree --write-tree --name-only -z` on conflict.
 * Format (NUL-separated): `<result tree OID>\0<conflict file name>\0...\0\0<info message segment...>` — the first field is the tree OID, followed
 * by each conflict file name; hitting an empty field (the double NUL between segments) ends the conflict-file segment, and the subsequent info-message segment is ignored. Deduplicate identical names.
 */
export function parseMergeTreeConflictsZ(raw: string): string[] {
  const parts = raw.split('\0');
  const files: string[] = [];
  // parts[0] = result tree OID; collect conflict file names starting from the next field, stopping at an empty field (segment separator).
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] === '') break;
    files.push(parts[i]!);
  }
  return [...new Set(files)];
}

/**
 * Parse `git blame --porcelain` output. Each hunk header looks like:
 *   `<sha> <origLine> <finalLine> [<numLines>]`
 * followed by `key value` metadata (author / author-mail / author-time / summary etc.),
 * and finally the tab-prefixed source line `\t<line>`. Subsequent hunk headers for the same commit carry only the sha
 * line, and the metadata must be inherited from the hunk header where it first appeared.
 */
/**
 * Parse the hunk headers of `git diff -U0`, collecting the set of "modified" line numbers on the head side.
 * A hunk header looks like `@@ -A,B +C,D @@`: the right-side C..C+D-1 segment is the lines head introduces/modifies.
 * A missing count is treated as 1; count=0 is a pure-deletion position with 0 head-side lines, skip it.
 */
export function parseHunkAddedLines(raw: string): Set<number> {
  const out = new Set<number>();
  for (const line of raw.split(/\r?\n/)) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number.parseInt(m[1]!, 10);
    const count = m[2] !== undefined ? Number.parseInt(m[2], 10) : 1;
    for (let i = 0; i < count; i++) out.add(start + i);
  }
  return out;
}

export function parseBlamePorcelain(raw: string): BlameLine[] {
  // On Windows git output often carries \r\n; split compatibly, otherwise the `^...(\d+)$` regex end
  // leaves a trailing \r causing all hunk headers to fail matching → parses to an empty array → blame neither shows nor errors
  const lines = raw.split(/\r?\n/);
  const commitMeta = new Map<
    string,
    { author: string; authorEmail: string; authorTime: number; summary: string }
  >();
  const out: BlameLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const head = lines[i];
    if (!head) {
      i++;
      continue;
    }
    const m = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(head);
    if (!m) {
      i++;
      continue;
    }
    const sha = m[1]!;
    const finalLine = Number.parseInt(m[3]!, 10);
    let author = '';
    let authorEmail = '';
    let authorTime = 0;
    let summary = '';
    i++;
    while (i < lines.length && !lines[i]!.startsWith('\t')) {
      const meta = lines[i]!;
      const sp = meta.indexOf(' ');
      const key = sp < 0 ? meta : meta.slice(0, sp);
      const value = sp < 0 ? '' : meta.slice(sp + 1);
      if (key === 'author') author = value;
      else if (key === 'author-mail') authorEmail = value.replace(/^<|>$/g, '');
      else if (key === 'author-time') authorTime = Number.parseInt(value, 10);
      else if (key === 'summary') summary = value;
      i++;
    }
    // Skip the source line (the \t-prefixed line is not metadata)
    if (i < lines.length && lines[i]!.startsWith('\t')) i++;

    let meta = commitMeta.get(sha);
    if (!meta && author) {
      meta = { author, authorEmail, authorTime, summary };
      commitMeta.set(sha, meta);
    }
    meta ??= commitMeta.get(sha) ?? { author: '', authorEmail: '', authorTime: 0, summary: '' };

    out.push({
      line: finalLine,
      commit: sha,
      author: meta.author,
      authorEmail: meta.authorEmail,
      authorDate: meta.authorTime ? new Date(meta.authorTime * 1000).toISOString() : '',
      summary: meta.summary,
    });
  }
  return out;
}

function mapStatusLetter(letter: string): ChangedFileStatus {
  switch (letter) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    default:
      return 'modified';
  }
}
