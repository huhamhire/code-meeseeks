import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendAgentNotes } from '../src/memory.js';

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'meebox-agent-mem-'));
}

describe('appendAgentNotes', () => {
  it('appends notes to USER.md under a managed heading and returns the added items', async () => {
    const dir = await tempDir();
    const added = await appendAgentNotes(dir, 'user', ['称呼: Kyle', '偏好简体中文']);
    expect(added).toEqual(['称呼: Kyle', '偏好简体中文']);
    const content = await readFile(path.join(dir, 'USER.md'), 'utf8');
    expect(content).toContain('## Agent 记录');
    expect(content).toContain('- 称呼: Kyle');
    expect(content).toContain('- 偏好简体中文');
  });

  it('dedups against existing content and within the batch (no duplicate writes)', async () => {
    const dir = await tempDir();
    await appendAgentNotes(dir, 'memory', ['repo uses g- prefix']);
    const added = await appendAgentNotes(dir, 'memory', ['repo uses g- prefix', 'new fact', 'new fact']);
    expect(added).toEqual(['new fact']); // 已存在的 / 批内重复的被跳过
    const content = await readFile(path.join(dir, 'MEMORY.md'), 'utf8');
    expect(content.match(/repo uses g- prefix/g)).toHaveLength(1);
    expect(content.match(/new fact/g)).toHaveLength(1);
  });

  it('writes to the file matching the kind (agents → AGENTS.md, append-only)', async () => {
    const dir = await tempDir();
    await appendAgentNotes(dir, 'agents', ['always verify tenant mapping']);
    const content = await readFile(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(content).toContain('- always verify tenant mapping');
  });

  it('returns empty for blank input without writing', async () => {
    const dir = await tempDir();
    const added = await appendAgentNotes(dir, 'user', ['', '   ']);
    expect(added).toEqual([]);
  });
});
