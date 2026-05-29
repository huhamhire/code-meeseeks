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
