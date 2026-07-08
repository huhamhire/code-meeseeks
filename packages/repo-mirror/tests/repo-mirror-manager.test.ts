import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import simpleGit from 'simple-git';
import {
  RepoMirrorManager,
  parseBlamePorcelain,
  parseHunkAddedLines,
  parseMergeTreeConflictsZ,
  stripGitCredentials,
} from '../src/repo-mirror-manager.js';
import type { RepoIdentity } from '../src/types.js';

let tmpRoot: string;
let upstreamPath: string;
let reposDir: string;

const repo: RepoIdentity = {
  host: 'bb.example.com',
  projectKey: 'FX',
  repoSlug: 'fx-help',
};

/** Create a fake upstream git repo that syncMirror can clone from. */
async function makeUpstream(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  // fallback: CI environment may not have user config
  await git.addConfig('user.email', 'test@example.com', false, 'local');
  await git.addConfig('user.name', 'Test', false, 'local');
  await git.addConfig('commit.gpgsign', 'false', false, 'local');
  await fs.writeFile(path.join(dir, 'README.md'), 'hello');
  await git.add('.');
  await git.commit('init');
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'meebox-mirror-test-'));
  upstreamPath = path.join(tmpRoot, 'upstream');
  reposDir = path.join(tmpRoot, 'repos');
  await makeUpstream(upstreamPath);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function makeManager(): RepoMirrorManager {
  return new RepoMirrorManager({
    reposDir,
    getCloneUrl: () => Promise.resolve(upstreamPath),
  });
}

describe('RepoMirrorManager.syncMirror', () => {
  it('first call clones bare into <reposDir>/<host>/<project>/<repo>/bare', async () => {
    const mgr = makeManager();
    const r = await mgr.syncMirror(repo);
    expect(r.freshClone).toBe(true);
    expect(r.mirrorPath).toBe(
      path.join(reposDir, 'bb.example.com', 'FX', 'fx-help', 'bare'),
    );
    // bare repo markers: HEAD file + config file exist
    await expect(fs.access(path.join(r.mirrorPath, 'HEAD'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(r.mirrorPath, 'config'))).resolves.toBeUndefined();
  });

  it('second call fetches (not clones) the existing mirror', async () => {
    const mgr = makeManager();
    await mgr.syncMirror(repo);

    // add a new commit in upstream
    const upstreamGit = simpleGit(upstreamPath);
    await fs.writeFile(path.join(upstreamPath, 'NEW.md'), 'new');
    await upstreamGit.add('.');
    await upstreamGit.commit('second');

    const r = await mgr.syncMirror(repo);
    expect(r.freshClone).toBe(false);

    // mirror should contain the new commit
    const mirrorGit = simpleGit(r.mirrorPath);
    const log = await mirrorGit.log();
    expect(log.total).toBeGreaterThanOrEqual(2);
  });

  it('fetch re-assembles the URL fresh instead of reusing the stored origin (token rotation)', async () => {
    // Simulate a token rotation: getCloneUrl returns upstreamA for the clone, then a DIFFERENT upstreamB for the
    // fetch. If the fetch reused the stored origin (upstreamA) it would miss upstreamB's new commit; the fix fetches
    // by the freshly re-assembled URL, so the rotated location/token takes effect without clearing the cache.
    const upstreamB = path.join(tmpRoot, 'upstream-b');
    await simpleGit(tmpRoot).clone(upstreamPath, upstreamB); // shares history with upstreamA
    const bGit = simpleGit(upstreamB);
    await bGit.addConfig('user.email', 'test@example.com', false, 'local');
    await bGit.addConfig('user.name', 'Test', false, 'local');
    await bGit.addConfig('commit.gpgsign', 'false', false, 'local');
    await fs.writeFile(path.join(upstreamB, 'ROTATED.md'), 'after rotate');
    await bGit.add('.');
    await bGit.commit('after rotate');
    const sha2 = (await bGit.revparse(['HEAD'])).trim();

    let call = 0;
    const mgr = new RepoMirrorManager({
      reposDir,
      getCloneUrl: () => Promise.resolve(++call === 1 ? upstreamPath : upstreamB),
    });
    await mgr.syncMirror(repo); // clone from upstreamA
    const r = await mgr.syncMirror(repo); // fetch — must use the fresh URL (upstreamB), not stored origin

    expect(r.freshClone).toBe(false); // fetched, did not fall back to a self-heal re-clone
    // upstreamB's new commit is only reachable if the fetch used the fresh URL
    expect(await mgr.hasCommit(repo, sha2)).toBe(true);
    // origin was migrated to the credential-free URL, and never left pointing at a stale one
    const originUrl = (
      await simpleGit(r.mirrorPath).raw(['config', '--get', 'remote.origin.url'])
    ).trim();
    expect(originUrl).toBe(upstreamB);
  });

  it('dedups concurrent syncMirror calls for the same repo (shared in-flight)', async () => {
    let urlCalls = 0;
    const mgr = new RepoMirrorManager({
      reposDir,
      getCloneUrl: async () => {
        urlCalls++;
        return upstreamPath;
      },
    });
    // 3 concurrent calls → all three reuse the same in-flight Promise, triggering only 1 actual clone
    const results = await Promise.all([
      mgr.syncMirror(repo),
      mgr.syncMirror(repo),
      mgr.syncMirror(repo),
    ]);
    expect(urlCalls).toBe(1);
    // all three calls should get the same MirrorResult reference (from the same Promise)
    expect(results[0]).toBe(results[1]);
    expect(results[0]).toBe(results[2]);
    expect(results[0]!.freshClone).toBe(true);
  });

  it('starts a fresh sync after the in-flight one completes (cleanup)', async () => {
    let urlCalls = 0;
    const mgr = new RepoMirrorManager({
      reposDir,
      getCloneUrl: async () => {
        urlCalls++;
        return upstreamPath;
      },
    });
    await mgr.syncMirror(repo);
    // after one sync completes, call again; should trigger a new sync (a fetch here, since the mirror already exists)
    await mgr.syncMirror(repo);
    // clone (1) + fetch (2): the fetch now re-assembles the authenticated URL fresh via getCloneUrl (instead of
    // reusing the stored origin), so a rotated token takes effect without clearing the cache.
    expect(urlCalls).toBe(2);
  });

  it('serializes syncMirror across different repos via global queue', async () => {
    // single global queue: different repos also run serially, but all complete successfully
    const otherRepo: RepoIdentity = { ...repo, repoSlug: 'fx-code' };
    const otherUpstream = path.join(tmpRoot, 'upstream-other');
    await makeUpstream(otherUpstream);

    const mgr = new RepoMirrorManager({
      reposDir,
      getCloneUrl: async (r) => (r.repoSlug === 'fx-help' ? upstreamPath : otherUpstream),
    });

    // track the max concurrency of doSyncMirror running at the same time
    let inFlight = 0;
    let maxInFlight = 0;
    const origGetCloneUrl = mgr['opts'].getCloneUrl;
    mgr['opts'].getCloneUrl = async (r) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // delay the clone step slightly to leave a window for concurrency
      await new Promise((res) => setTimeout(res, 10));
      const url = await origGetCloneUrl(r);
      inFlight--;
      return url;
    };

    const [a, b] = await Promise.all([mgr.syncMirror(repo), mgr.syncMirror(otherRepo)]);
    expect(a.freshClone).toBe(true);
    expect(b.freshClone).toBe(true);
    expect(a.mirrorPath).not.toBe(b.mirrorPath);
    // key: the global queue guarantees at most 1 clone running at any moment
    expect(maxInFlight).toBe(1);
  });

  it('isolates failures: failed call does not poison subsequent calls', async () => {
    let attempt = 0;
    const mgr = new RepoMirrorManager({
      reposDir,
      getCloneUrl: async () => {
        attempt++;
        if (attempt === 1) return '/nonexistent-upstream-path';
        return upstreamPath;
      },
    });
    await expect(mgr.syncMirror(repo)).rejects.toBeDefined();
    // the second call uses the real upstream and should succeed
    const r2 = await mgr.syncMirror(repo);
    expect(r2.freshClone).toBe(true);
  });
});

describe('RepoMirrorManager.getSize', () => {
  it('returns 0 when mirror does not exist', async () => {
    const mgr = makeManager();
    const s = await mgr.getSize(repo);
    expect(s.totalBytes).toBe(0);
  });

  it('returns >0 after syncMirror', async () => {
    const mgr = makeManager();
    await mgr.syncMirror(repo);
    const s = await mgr.getSize(repo);
    expect(s.totalBytes).toBeGreaterThan(0);
  });
});

describe('RepoMirrorManager.mirrorPath', () => {
  it('builds <reposDir>/<host>/<project>/<repo>/bare', () => {
    const mgr = makeManager();
    expect(mgr.mirrorPath(repo)).toBe(
      path.join(reposDir, 'bb.example.com', 'FX', 'fx-help', 'bare'),
    );
  });
});

describe('RepoMirrorManager diff/content', () => {
  /** Prepare 2 commits in upstream, return base / head sha. */
  async function prepareTwoCommits(): Promise<{ baseSha: string; headSha: string }> {
    const upstream = simpleGit(upstreamPath);

    // reset: the outer beforeEach already init + commit README; deleting and redoing is more controllable
    await fs.rm(upstreamPath, { recursive: true, force: true });
    await fs.mkdir(upstreamPath, { recursive: true });
    await upstream.init();
    await upstream.addConfig('user.email', 'test@example.com', false, 'local');
    await upstream.addConfig('user.name', 'Test', false, 'local');
    await upstream.addConfig('commit.gpgsign', 'false', false, 'local');

    await fs.writeFile(path.join(upstreamPath, 'a.txt'), 'line1\nline2\n');
    await fs.writeFile(path.join(upstreamPath, 'b.txt'), 'old b\n');
    await fs.writeFile(path.join(upstreamPath, 'rename-me.txt'), 'will be renamed\n');
    await upstream.add('.');
    await upstream.commit('base');
    const baseSha = (await upstream.revparse(['HEAD'])).trim();

    // commit 2:
    //   modify a.txt
    //   delete b.txt
    //   add c.txt
    //   rename rename-me.txt → renamed.txt
    await fs.writeFile(path.join(upstreamPath, 'a.txt'), 'line1\nline2\nline3-new\n');
    await fs.rm(path.join(upstreamPath, 'b.txt'));
    await fs.writeFile(path.join(upstreamPath, 'c.txt'), 'brand new\n');
    await fs.rename(
      path.join(upstreamPath, 'rename-me.txt'),
      path.join(upstreamPath, 'renamed.txt'),
    );
    await upstream.add('.');
    await upstream.commit('changes');
    const headSha = (await upstream.revparse(['HEAD'])).trim();

    return { baseSha, headSha };
  }

  it('listChangedFiles maps A/M/D/R from `git diff --name-status`', async () => {
    const { baseSha, headSha } = await prepareTwoCommits();
    const mgr = makeManager();
    await mgr.syncMirror(repo);

    const files = await mgr.listChangedFiles(repo, baseSha, headSha);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('a.txt')?.status).toBe('modified');
    expect(byPath.get('c.txt')?.status).toBe('added');
    expect(byPath.get('b.txt')?.status).toBe('deleted');
    const renamed = byPath.get('renamed.txt');
    expect(renamed?.status).toBe('renamed');
    expect(renamed?.oldPath).toBe('rename-me.txt');
    expect(typeof renamed?.similarity).toBe('number');
  });

  it('getFileContent returns text content at a sha', async () => {
    const { baseSha, headSha } = await prepareTwoCommits();
    const mgr = makeManager();
    await mgr.syncMirror(repo);

    const atBase = await mgr.getFileContent(repo, baseSha, 'a.txt');
    expect(atBase).toEqual({ binary: false, content: 'line1\nline2\n' });

    const atHead = await mgr.getFileContent(repo, headSha, 'a.txt');
    expect(atHead).toEqual({ binary: false, content: 'line1\nline2\nline3-new\n' });
  });

  it('getFileContent returns empty content for files not present at that sha', async () => {
    const { baseSha, headSha } = await prepareTwoCommits();
    const mgr = makeManager();
    await mgr.syncMirror(repo);

    // c.txt does not exist at base
    expect(await mgr.getFileContent(repo, baseSha, 'c.txt')).toEqual({
      binary: false,
      content: '',
    });
    // b.txt does not exist at head
    expect(await mgr.getFileContent(repo, headSha, 'b.txt')).toEqual({
      binary: false,
      content: '',
    });
  });

  it('parseHunkAddedLines collects the set of added/modified line numbers on the head side', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      'index aaaa..bbbb 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      // modify 1 line @ head:5
      '@@ -5,1 +5,1 @@',
      '-old',
      '+new',
      // add 3 lines @ head:10..12 (count-omitted form + multiple lines)
      '@@ -10,0 +10,3 @@',
      '+line a',
      '+line b',
      '+line c',
      // pure deletion: 0 lines on the head side
      '@@ -20,2 +21,0 @@',
      '-del a',
      '-del b',
      // no count is treated as 1
      '@@ -30 +31 @@',
      '-zz',
      '+yy',
      '',
    ].join('\n');
    const set = parseHunkAddedLines(diff);
    expect([...set].sort((a, b) => a - b)).toEqual([5, 10, 11, 12, 31]);
  });

  it('parseHunkAddedLines handles CRLF', () => {
    const lf = '@@ -1,1 +1,1 @@\n-a\n+b\n@@ -5,0 +5,2 @@\n+c\n+d\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    expect([...parseHunkAddedLines(crlf)].sort((a, b) => a - b)).toEqual([1, 5, 6]);
  });

  it('parseBlamePorcelain handles LF / CRLF line endings', () => {
    const sha = 'a'.repeat(40);
    // git output on Windows often carries \r\n; ensure hunk headers still match
    const lf = [
      `${sha} 1 1 2`,
      'author Kyle',
      'author-mail <kyle@example.com>',
      'author-time 1717000000',
      'author-tz +0800',
      'summary first',
      'filename a.ts',
      '\tline 1',
      `${sha} 2 2`,
      'filename a.ts',
      '\tline 2',
      '',
    ].join('\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    const fromLf = parseBlamePorcelain(lf);
    const fromCrlf = parseBlamePorcelain(crlf);
    expect(fromLf).toHaveLength(2);
    expect(fromCrlf).toHaveLength(2);
    expect(fromCrlf[0]!.author).toBe('Kyle');
    expect(fromCrlf[0]!.authorEmail).toBe('kyle@example.com');
    expect(fromCrlf[1]!.commit).toBe(sha);
    expect(fromCrlf[1]!.line).toBe(2);
    // metadata for later hunks of the same commit should be inherited from its first occurrence
    expect(fromCrlf[1]!.author).toBe('Kyle');
  });

  it('getFileContent flags binary on null-byte presence', async () => {
    // custom upstream with a binary file
    const upstream = simpleGit(upstreamPath);
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]); // PNG header contains NUL
    await fs.writeFile(path.join(upstreamPath, 'icon.png'), buf);
    await upstream.add('.');
    await upstream.commit('add binary');
    const sha = (await upstream.revparse(['HEAD'])).trim();

    const mgr = makeManager();
    await mgr.syncMirror(repo);

    const r = await mgr.getFileContent(repo, sha, 'icon.png');
    expect(r.binary).toBe(true);
    // A plain inline binary is not LFS-managed.
    expect(r.binary === true && r.lfs).toBeUndefined();
  });

  it('getFileContent detects a Git LFS pointer and surfaces its size', async () => {
    // An LFS-managed file is stored in git as a small pointer blob (the mirror never smudges), so getFileContent sees
    // the pointer text; it should flag binary + carry the declared size instead of returning the pointer as text.
    const upstream = simpleGit(upstreamPath);
    const pointer =
      'version https://git-lfs.github.com/spec/v1\n' +
      'oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\n' +
      'size 12345\n';
    await fs.writeFile(path.join(upstreamPath, 'big.psd'), pointer);
    await upstream.add('.');
    await upstream.commit('add lfs pointer');
    const sha = (await upstream.revparse(['HEAD'])).trim();

    const mgr = makeManager();
    await mgr.syncMirror(repo);

    const r = await mgr.getFileContent(repo, sha, 'big.psd');
    expect(r).toEqual({ binary: true, lfs: { size: 12345 } });
  });

  it('parseMergeTreeConflictsZ takes conflict file names between the first OID and the section-separating double NUL (deduped)', () => {
    // stdout of `git merge-tree --write-tree --name-only -z` on conflict: OID\0 file\0 \0(section separator) message...
    const raw =
      '4530c9c9c26e09ddc2340fd825c09a190039d7d2\0f.txt\0src/x y.ts\0\0' +
      '1\0f.txt\0CONFLICT (content): Merge conflict in f.txt\0';
    expect(parseMergeTreeConflictsZ(raw)).toEqual(['f.txt', 'src/x y.ts']);
  });

  it('parseMergeTreeConflictsZ returns an empty array when there are no conflict files (section separator right after the first field)', () => {
    expect(parseMergeTreeConflictsZ('4530c9c9\0\0info')).toEqual([]);
  });

  it('listConflictFiles lists files that would conflict when trial-merging into the target branch', async () => {
    const upstream = simpleGit(upstreamPath);
    await upstream.addConfig('commit.gpgsign', 'false', false, 'local');
    // target branch name (init defaults to master / main, depending on environment); checked out again later.
    const main = (await upstream.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    // base: two files
    await fs.writeFile(path.join(upstreamPath, 'shared.txt'), 'a\nb\nc\n');
    await fs.writeFile(path.join(upstreamPath, 'solo.txt'), 'x\n');
    await upstream.add('.');
    await upstream.commit('conflict base');
    const baseSha = (await upstream.revparse(['HEAD'])).trim();

    // feature branch: modify the second line of shared.txt + modify solo.txt
    await upstream.checkoutLocalBranch('feature');
    await fs.writeFile(path.join(upstreamPath, 'shared.txt'), 'a\nb-feature\nc\n');
    await fs.writeFile(path.join(upstreamPath, 'solo.txt'), 'x-feature\n');
    await upstream.add('.');
    await upstream.commit('feature edit');
    const featureSha = (await upstream.revparse(['HEAD'])).trim();

    // back to the target branch and make a conflicting change to the same line of shared.txt; leave solo.txt untouched → only shared.txt conflicts
    await upstream.checkout([main]);
    await fs.writeFile(path.join(upstreamPath, 'shared.txt'), 'a\nb-main\nc\n');
    await upstream.add('.');
    await upstream.commit('main edit');
    const targetSha = (await upstream.revparse([main])).trim();
    expect(targetSha).not.toBe(baseSha);

    const mgr = makeManager();
    await mgr.syncMirror(repo);

    const conflicts = await mgr.listConflictFiles(repo, targetSha, featureSha);
    expect(conflicts).toContain('shared.txt');
    expect(conflicts).not.toContain('solo.txt');

    // non-conflicting direction (same branch against itself) → empty
    expect(await mgr.listConflictFiles(repo, targetSha, targetSha)).toEqual([]);
  });
});

describe('RepoMirrorManager.materializeWorktree', () => {
  it('derives a self-contained worktree from the bare mirror, with HEAD on the pr-<localId>/head named branch', async () => {
    const mgr = makeManager();
    await mgr.syncMirror(repo);
    const headSha = (await simpleGit(upstreamPath).revparse(['HEAD'])).trim();

    const wt = await mgr.materializeWorktree(repo, headSha, undefined, 'pr01hash');
    try {
      // the worktree path is under <reposDir>/<host>/<project>/<repo>/wt/
      expect(wt.path.startsWith(path.join(reposDir, 'bb.example.com', 'FX', 'fx-help', 'wt'))).toBe(
        true,
      );
      // .git must be a directory (self-contained clone), not a file (worktree-style link)
      const gitStat = await fs.stat(path.join(wt.path, '.git'));
      expect(gitStat.isDirectory()).toBe(true);
      // README.md (file from upstream's initial commit) should be checked out to the worktree
      const readme = await fs.readFile(path.join(wt.path, 'README.md'), 'utf8');
      expect(readme).toBe('hello');
      // HEAD must be on the named branch pr-<localId>/head (pr-agent requires it, cannot be detached)
      const headRef = (await simpleGit(wt.path).raw(['symbolic-ref', 'HEAD'])).trim();
      expect(headRef).toBe('refs/heads/pr-pr01hash/head');
      expect(wt.headBranchName).toBe('pr-pr01hash/head');
      // the branch should point at headSha
      const branchSha = (
        await simpleGit(wt.path).revparse(['refs/heads/pr-pr01hash/head'])
      ).trim();
      expect(branchSha).toBe(headSha);
      // no baseSha passed → no target branch
      expect(wt.targetBranchName).toBeUndefined();
    } finally {
      await wt.cleanup();
    }
  });

  it('when baseSha is passed, creates the pr-<localId>/base branch and targetBranchName returns that name', async () => {
    const mgr = makeManager();
    await mgr.syncMirror(repo);
    // add a new commit in upstream; use the initial commit as base and the new commit as head
    const baseSha = (await simpleGit(upstreamPath).revparse(['HEAD'])).trim();
    const upstreamGit = simpleGit(upstreamPath);
    await fs.writeFile(path.join(upstreamPath, 'NEW.md'), 'feature');
    await upstreamGit.add('.');
    await upstreamGit.commit('feature commit');
    const headSha = (await upstreamGit.revparse(['HEAD'])).trim();
    await mgr.syncMirror(repo); // fetch new ref into mirror

    const wt = await mgr.materializeWorktree(repo, headSha, baseSha, 'pr01hash');
    try {
      expect(wt.targetBranchName).toBe('pr-pr01hash/base');
      const baseBranchSha = (
        await simpleGit(wt.path).revparse(['refs/heads/pr-pr01hash/base'])
      ).trim();
      expect(baseBranchSha).toBe(baseSha);
      // head is still on pr-<localId>/head
      const headBranchSha = (
        await simpleGit(wt.path).revparse(['refs/heads/pr-pr01hash/head'])
      ).trim();
      expect(headBranchSha).toBe(headSha);
    } finally {
      await wt.cleanup();
    }
  });

  it('the worktree directory is gone after cleanup', async () => {
    const mgr = makeManager();
    await mgr.syncMirror(repo);
    const headSha = (await simpleGit(upstreamPath).revparse(['HEAD'])).trim();
    const wt = await mgr.materializeWorktree(repo, headSha);
    await wt.cleanup();
    await expect(fs.access(wt.path)).rejects.toThrow();
  });

  it('deriving multiple worktrees concurrently does not collide on names (Date.now + random suffix)', async () => {
    const mgr = makeManager();
    await mgr.syncMirror(repo);
    const headSha = (await simpleGit(upstreamPath).revparse(['HEAD'])).trim();
    const [w1, w2, w3] = await Promise.all([
      mgr.materializeWorktree(repo, headSha),
      mgr.materializeWorktree(repo, headSha),
      mgr.materializeWorktree(repo, headSha),
    ]);
    try {
      expect(new Set([w1.path, w2.path, w3.path]).size).toBe(3);
    } finally {
      await Promise.all([w1.cleanup(), w2.cleanup(), w3.cleanup()]);
    }
  });
});

describe('stripGitCredentials', () => {
  it('strips user + token from an https clone URL', () => {
    expect(stripGitCredentials('https://alice:PAT123@bb.example.com/scm/FX/fx-help.git')).toBe(
      'https://bb.example.com/scm/FX/fx-help.git',
    );
  });

  it('strips a token even when only a username (or only a password) is present', () => {
    expect(stripGitCredentials('https://x-token-auth:tok@host/o/r.git')).toBe('https://host/o/r.git');
    expect(stripGitCredentials('https://tokenonly@host/o/r.git')).toBe('https://host/o/r.git');
  });

  it('leaves a credential-free https URL unchanged', () => {
    expect(stripGitCredentials('https://bb.example.com/scm/FX/fx-help.git')).toBe(
      'https://bb.example.com/scm/FX/fx-help.git',
    );
  });

  it('leaves an scp-like ssh remote unchanged (not a URL, no embedded token)', () => {
    expect(stripGitCredentials('git@bb.example.com:FX/fx-help.git')).toBe(
      'git@bb.example.com:FX/fx-help.git',
    );
  });
});
