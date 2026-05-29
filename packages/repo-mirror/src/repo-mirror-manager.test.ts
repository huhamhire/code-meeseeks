import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import simpleGit from 'simple-git';
import { RepoMirrorManager } from './repo-mirror-manager.js';
import type { RepoIdentity } from './types.js';

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

  it('serializes concurrent syncMirror calls for the same repo', async () => {
    const mgr = makeManager();
    // 并发 3 次 → 应当都成功，目录只 clone 一次（freshClone 仅首次 true）
    const results = await Promise.all([
      mgr.syncMirror(repo),
      mgr.syncMirror(repo),
      mgr.syncMirror(repo),
    ]);
    const fresh = results.filter((r) => r.freshClone);
    expect(fresh).toHaveLength(1);
    expect(results.every((r) => r.mirrorPath === results[0]!.mirrorPath)).toBe(true);
  });

  it('parallelizes syncMirror calls for different repos', async () => {
    const otherRepo: RepoIdentity = { ...repo, repoSlug: 'fx-code' };
    const otherUpstream = path.join(tmpRoot, 'upstream-other');
    await makeUpstream(otherUpstream);

    const mgr = new RepoMirrorManager({
      reposDir,
      getCloneUrl: async (r) => (r.repoSlug === 'fx-help' ? upstreamPath : otherUpstream),
    });

    const [a, b] = await Promise.all([mgr.syncMirror(repo), mgr.syncMirror(otherRepo)]);
    expect(a.freshClone).toBe(true);
    expect(b.freshClone).toBe(true);
    expect(a.mirrorPath).not.toBe(b.mirrorPath);
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
