import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgentContext } from '../src/load.js';
import { scaffoldAgentDir } from '../src/scaffold.js';

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
    expect(created).toContain('rules/example.md');

    const soul = await readFile(path.join(dir, 'SOUL.md'), 'utf8');
    expect(soul.length).toBeGreaterThan(0);

    // 第二次脚手架不重复创建（幂等）
    const again = await scaffoldAgentDir(dir);
    expect(again).toEqual([]);
  });

  it('does not overwrite an existing file', async () => {
    await writeFile(path.join(dir, 'SOUL.md'), '# custom', 'utf8');
    const created = await scaffoldAgentDir(dir);
    expect(created).not.toContain('SOUL.md');
    expect(await readFile(path.join(dir, 'SOUL.md'), 'utf8')).toBe('# custom');
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
