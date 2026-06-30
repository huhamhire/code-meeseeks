import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgentContext, scaffoldAgentDir } from '../src/agent-files.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'meebox-agent-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('scaffoldAgentDir', () => {
  it('creates the template files on an empty dir, idempotently', async () => {
    const created = await scaffoldAgentDir(dir);
    expect(created).toContain('SOUL.md');
    expect(created).toContain('AGENTS.md');
    expect(created).toContain('README.md');
    expect(created).toContain('rules/example.md');

    const soul = await readFile(path.join(dir, 'SOUL.md'), 'utf8');
    expect(soul.length).toBeGreaterThan(0);

    // 第二次脚手架不重复创建（幂等）
    const again = await scaffoldAgentDir(dir);
    expect(again).toEqual([]);
  });

  it('does not recreate the seed-once example rule after deletion', async () => {
    await scaffoldAgentDir(dir);
    // 用户删掉示例规则——首次播种文件，删除后不应被复活。
    await unlink(path.join(dir, 'rules/example.md'));
    const again = await scaffoldAgentDir(dir);
    expect(again).not.toContain('rules/example.md');
    await expect(readFile(path.join(dir, 'rules/example.md'), 'utf8')).rejects.toThrow();
  });

  it('recreates a deleted user-owned README (create-if-missing)', async () => {
    await scaffoldAgentDir(dir);
    // README 属用户所有的「缺失即创建」，删除后下次脚手架补回（与首次播种的示例规则相区别）。
    await unlink(path.join(dir, 'README.md'));
    const again = await scaffoldAgentDir(dir);
    expect(again).toContain('README.md');
  });

  it('does not overwrite a user-owned file', async () => {
    await writeFile(path.join(dir, 'USER.md'), '# custom', 'utf8');
    const created = await scaffoldAgentDir(dir);
    expect(created).not.toContain('USER.md');
    expect(await readFile(path.join(dir, 'USER.md'), 'utf8')).toBe('# custom');
  });

  it('realigns the managed SOUL.md back to the built-in template', async () => {
    await scaffoldAgentDir(dir);
    const template = await readFile(path.join(dir, 'SOUL.md'), 'utf8');
    // 用户本地改动 SOUL.md —— 不被认可，下次脚手架对齐回模版。
    await writeFile(path.join(dir, 'SOUL.md'), '# locally edited', 'utf8');
    const written = await scaffoldAgentDir(dir);
    expect(written).toContain('SOUL.md');
    expect(await readFile(path.join(dir, 'SOUL.md'), 'utf8')).toBe(template);
  });
});

describe('loadAgentContext', () => {
  it('returns empty context for an empty agentDir', async () => {
    const ctx = await loadAgentContext('');
    expect(ctx.files).toEqual({ soul: '', agents: '', memory: '', user: '' });
    expect(ctx.rules).toEqual([]);
  });

  it('reads scaffolded files and loads rules from the rules/ subdir', async () => {
    await scaffoldAgentDir(dir);
    const ctx = await loadAgentContext(dir);
    expect(ctx.files.soul).toContain('Soul');
    expect(ctx.files.agents).toContain('Working Agreement');
    // 模版示例规则被加载（enabled: false，仅验证被解析）
    expect(ctx.rules.length).toBe(1);
    expect(ctx.rules[0]?.enabled).toBe(false);
  });

  it('treats missing context files as empty (failure-safe)', async () => {
    // 只有 rules 目录、无四个上下文文件
    const ctx = await loadAgentContext(dir);
    expect(ctx.files.soul).toBe('');
    expect(ctx.files.memory).toBe('');
    expect(ctx.rules).toEqual([]);
  });
});
