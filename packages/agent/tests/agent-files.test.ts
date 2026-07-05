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

    // second scaffold does not re-create (idempotent)
    const again = await scaffoldAgentDir(dir);
    expect(again).toEqual([]);
  });

  it('does not recreate the seed-once example rule after deletion', async () => {
    await scaffoldAgentDir(dir);
    // user deletes the example rule—a seed-once file, it should not be revived after deletion.
    await unlink(path.join(dir, 'rules/example.md'));
    const again = await scaffoldAgentDir(dir);
    expect(again).not.toContain('rules/example.md');
    await expect(readFile(path.join(dir, 'rules/example.md'), 'utf8')).rejects.toThrow();
  });

  it('recreates a deleted user-owned README (create-if-missing)', async () => {
    await scaffoldAgentDir(dir);
    // README is user-owned "create-if-missing"; the next scaffold restores it after deletion (distinct from the seed-once example rule).
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
    // user locally edits SOUL.md—not honored, the next scaffold realigns it back to the template.
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
    // the template example rule is loaded (enabled: false, only verifying it's parsed)
    expect(ctx.rules.length).toBe(1);
    expect(ctx.rules[0]?.enabled).toBe(false);
  });

  it('treats missing context files as empty (failure-safe)', async () => {
    // only the rules dir, none of the four context files
    const ctx = await loadAgentContext(dir);
    expect(ctx.files.soul).toBe('');
    expect(ctx.files.memory).toBe('');
    expect(ctx.rules).toEqual([]);
  });
});
