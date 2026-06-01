import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import simpleGit from 'simple-git';
import {
  RepoMirrorManager,
  parseBlamePorcelain,
  parseHunkAddedLines,
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

/** 创建一个 fake upstream git 仓库，能让 syncMirror clone 自它。 */
async function makeUpstream(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  // 容错：CI 环境可能没有 user 配置
  await git.addConfig('user.email', 'test@example.com', false, 'local');
  await git.addConfig('user.name', 'Test', false, 'local');
  await git.addConfig('commit.gpgsign', 'false', false, 'local');
  await fs.writeFile(path.join(dir, 'README.md'), 'hello');
  await git.add('.');
  await git.commit('init');
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-pilot-mirror-test-'));
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
    // bare repo 标志：HEAD 文件 + config 文件存在
    await expect(fs.access(path.join(r.mirrorPath, 'HEAD'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(r.mirrorPath, 'config'))).resolves.toBeUndefined();
  });

  it('second call fetches (not clones) the existing mirror', async () => {
    const mgr = makeManager();
    await mgr.syncMirror(repo);

    // 在 upstream 里加新 commit
    const upstreamGit = simpleGit(upstreamPath);
    await fs.writeFile(path.join(upstreamPath, 'NEW.md'), 'new');
    await upstreamGit.add('.');
    await upstreamGit.commit('second');

    const r = await mgr.syncMirror(repo);
    expect(r.freshClone).toBe(false);

    // 镜像应包含新 commit
    const mirrorGit = simpleGit(r.mirrorPath);
    const log = await mirrorGit.log();
    expect(log.total).toBeGreaterThanOrEqual(2);
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
    // 并发 3 次 → 三个调用复用同一 in-flight Promise，只触发 1 次实际 clone
    const results = await Promise.all([
      mgr.syncMirror(repo),
      mgr.syncMirror(repo),
      mgr.syncMirror(repo),
    ]);
    expect(urlCalls).toBe(1);
    // 三个调用拿到的应当是同一个 MirrorResult 引用（来自同一 Promise）
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
    // 一次同步完成后再调一次，应触发新的 sync（这里是 fetch，因为镜像已存在）
    await mgr.syncMirror(repo);
    expect(urlCalls).toBe(1); // clone 仅 1 次；fetch 不走 getCloneUrl
  });

  it('serializes syncMirror across different repos via global queue', async () => {
    // 全局单队列：不同 repo 也串行执行，但都能成功完成
    const otherRepo: RepoIdentity = { ...repo, repoSlug: 'fx-code' };
    const otherUpstream = path.join(tmpRoot, 'upstream-other');
    await makeUpstream(otherUpstream);

    const mgr = new RepoMirrorManager({
      reposDir,
      getCloneUrl: async (r) => (r.repoSlug === 'fx-help' ? upstreamPath : otherUpstream),
    });

    // 跟踪 doSyncMirror 同时运行的最大并发数
    let inFlight = 0;
    let maxInFlight = 0;
    const origGetCloneUrl = mgr['opts'].getCloneUrl;
    mgr['opts'].getCloneUrl = async (r) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // 让 clone 步骤稍稍延后，给同时性留窗口
      await new Promise((res) => setTimeout(res, 10));
      const url = await origGetCloneUrl(r);
      inFlight--;
      return url;
    };

    const [a, b] = await Promise.all([mgr.syncMirror(repo), mgr.syncMirror(otherRepo)]);
    expect(a.freshClone).toBe(true);
    expect(b.freshClone).toBe(true);
    expect(a.mirrorPath).not.toBe(b.mirrorPath);
    // 关键：全局队列保证任何时刻最多 1 个 clone 在跑
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
    // 第二次走真正的 upstream，应该成功
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
  /** 在 upstream 准备 2 个 commit，返回 base / head sha。 */
  async function prepareTwoCommits(): Promise<{ baseSha: string; headSha: string }> {
    const upstream = simpleGit(upstreamPath);

    // 重置：上层 beforeEach 已经 init + commit README，删了重来更可控
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

    // c.txt 在 base 不存在
    expect(await mgr.getFileContent(repo, baseSha, 'c.txt')).toEqual({
      binary: false,
      content: '',
    });
    // b.txt 在 head 不存在
    expect(await mgr.getFileContent(repo, headSha, 'b.txt')).toEqual({
      binary: false,
      content: '',
    });
  });

  it('parseHunkAddedLines 收集 head 侧添加/修改行号集合', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      'index aaaa..bbbb 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      // 改 1 行 @ head:5
      '@@ -5,1 +5,1 @@',
      '-old',
      '+new',
      // 加 3 行 @ head:10..12 (count 省略形式 + 多行)
      '@@ -10,0 +10,3 @@',
      '+line a',
      '+line b',
      '+line c',
      // 纯删除：head 侧 0 行
      '@@ -20,2 +21,0 @@',
      '-del a',
      '-del b',
      // 无 count 视为 1
      '@@ -30 +31 @@',
      '-zz',
      '+yy',
      '',
    ].join('\n');
    const set = parseHunkAddedLines(diff);
    expect([...set].sort((a, b) => a - b)).toEqual([5, 10, 11, 12, 31]);
  });

  it('parseHunkAddedLines 兼容 CRLF', () => {
    const lf = '@@ -1,1 +1,1 @@\n-a\n+b\n@@ -5,0 +5,2 @@\n+c\n+d\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    expect([...parseHunkAddedLines(crlf)].sort((a, b) => a - b)).toEqual([1, 5, 6]);
  });

  it('parseBlamePorcelain 兼容 LF / CRLF 行尾', () => {
    const sha = 'a'.repeat(40);
    // Windows 上 git 输出经常带 \r\n，要保证仍能匹配 hunk 头
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
    // 同 commit 的后续 hunk 元信息应继承自首次出现
    expect(fromCrlf[1]!.author).toBe('Kyle');
  });

  it('getFileContent flags binary on null-byte presence', async () => {
    // 自定义 upstream with a binary file
    const upstream = simpleGit(upstreamPath);
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]); // PNG header含 NUL
    await fs.writeFile(path.join(upstreamPath, 'icon.png'), buf);
    await upstream.add('.');
    await upstream.commit('add binary');
    const sha = (await upstream.revparse(['HEAD'])).trim();

    const mgr = makeManager();
    await mgr.syncMirror(repo);

    const r = await mgr.getFileContent(repo, sha, 'icon.png');
    expect(r.binary).toBe(true);
  });
});

describe('RepoMirrorManager.materializeWorktree', () => {
  it('从 bare mirror 派生 self-contained worktree, HEAD 在 pr-pilot/head 命名分支上', async () => {
    const mgr = makeManager();
    await mgr.syncMirror(repo);
    const headSha = (await simpleGit(upstreamPath).revparse(['HEAD'])).trim();

    const wt = await mgr.materializeWorktree(repo, headSha);
    try {
      // worktree 路径在 <reposDir>/<host>/<project>/<repo>/wt/ 下
      expect(wt.path.startsWith(path.join(reposDir, 'bb.example.com', 'FX', 'fx-help', 'wt'))).toBe(
        true,
      );
      // .git 必须是目录 (self-contained clone)，不是 file (worktree-style 链)
      const gitStat = await fs.stat(path.join(wt.path, '.git'));
      expect(gitStat.isDirectory()).toBe(true);
      // README.md (upstream 初始 commit 的文件) 应该被 checkout 到工作树
      const readme = await fs.readFile(path.join(wt.path, 'README.md'), 'utf8');
      expect(readme).toBe('hello');
      // HEAD 必须在命名分支 pr-pilot/head 上 (pr-agent 要求，不能 detached)
      const headRef = (await simpleGit(wt.path).raw(['symbolic-ref', 'HEAD'])).trim();
      expect(headRef).toBe('refs/heads/pr-pilot/head');
      expect(wt.headBranchName).toBe('pr-pilot/head');
      // 该分支应该指向 headSha
      const branchSha = (
        await simpleGit(wt.path).revparse(['refs/heads/pr-pilot/head'])
      ).trim();
      expect(branchSha).toBe(headSha);
      // 没传 baseSha → 没有 target branch
      expect(wt.targetBranchName).toBeUndefined();
    } finally {
      await wt.cleanup();
    }
  });

  it('baseSha 传入后建 pr-pilot/base 分支，targetBranchName 返回该名字', async () => {
    const mgr = makeManager();
    await mgr.syncMirror(repo);
    // upstream 加一个新 commit；用初始 commit 当 base，新 commit 当 head
    const baseSha = (await simpleGit(upstreamPath).revparse(['HEAD'])).trim();
    const upstreamGit = simpleGit(upstreamPath);
    await fs.writeFile(path.join(upstreamPath, 'NEW.md'), 'feature');
    await upstreamGit.add('.');
    await upstreamGit.commit('feature commit');
    const headSha = (await upstreamGit.revparse(['HEAD'])).trim();
    await mgr.syncMirror(repo); // fetch new ref into mirror

    const wt = await mgr.materializeWorktree(repo, headSha, baseSha);
    try {
      expect(wt.targetBranchName).toBe('pr-pilot/base');
      const baseBranchSha = (
        await simpleGit(wt.path).revparse(['refs/heads/pr-pilot/base'])
      ).trim();
      expect(baseBranchSha).toBe(baseSha);
      // head 仍在 pr-pilot/head
      const headBranchSha = (
        await simpleGit(wt.path).revparse(['refs/heads/pr-pilot/head'])
      ).trim();
      expect(headBranchSha).toBe(headSha);
    } finally {
      await wt.cleanup();
    }
  });

  it('cleanup 后 worktree 目录消失', async () => {
    const mgr = makeManager();
    await mgr.syncMirror(repo);
    const headSha = (await simpleGit(upstreamPath).revparse(['HEAD'])).trim();
    const wt = await mgr.materializeWorktree(repo, headSha);
    await wt.cleanup();
    await expect(fs.access(wt.path)).rejects.toThrow();
  });

  it('并发派生多个 worktree 不会撞名 (Date.now + 随机后缀)', async () => {
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
