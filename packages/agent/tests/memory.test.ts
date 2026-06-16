import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendAgentNotes } from '../src/memory.js';

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'meebox-agent-mem-'));
}

describe('appendAgentNotes', () => {
  it('creates the target section when missing and returns the added items', async () => {
    const dir = await tempDir();
    const added = await appendAgentNotes(dir, 'user', [
      { section: 'Review preferences', note: '称呼: Kyle' },
      { section: 'Review preferences', note: '偏好简体中文' },
    ]);
    expect(added).toEqual(['称呼: Kyle', '偏好简体中文']);
    const content = await readFile(path.join(dir, 'USER.md'), 'utf8');
    expect(content).toBe('## Review preferences\n- 称呼: Kyle\n- 偏好简体中文\n');
  });

  it('appends a note to the end of an EXISTING matching section, before the next heading', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'AGENTS.md');
    await writeFile(file, '# Title\n\n## AutoPilot\n- skip branch merges\n\n## Grants\n- none\n', 'utf8');
    const added = await appendAgentNotes(dir, 'agents', [
      { section: 'AutoPilot', note: 'skip pure dependency bumps' },
    ]);
    expect(added).toEqual(['skip pure dependency bumps']);
    const content = await readFile(file, 'utf8');
    // 插到 AutoPilot 节末尾、Grants 之前，不破坏后续章节。
    expect(content).toBe(
      '# Title\n\n## AutoPilot\n- skip branch merges\n- skip pure dependency bumps\n\n## Grants\n- none\n',
    );
  });

  it('creates a new section at file end when the target heading is missing', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'MEMORY.md');
    await writeFile(file, '## 项目约定\n- existing\n', 'utf8');
    await appendAgentNotes(dir, 'memory', [{ section: '平台清单', note: 'GitHub → Bitbucket → GitLab' }]);
    const content = await readFile(file, 'utf8');
    expect(content).toBe('## 项目约定\n- existing\n\n## 平台清单\n- GitHub → Bitbucket → GitLab\n');
  });

  it('drops notes without a section (un-abstractable → not durable memory)', async () => {
    const dir = await tempDir();
    const added = await appendAgentNotes(dir, 'memory', [
      { section: '', note: 'this restates a PR finding' },
      { section: '   ', note: 'another finding' },
    ]);
    expect(added).toEqual([]);
    // 全被丢弃 → 不建文件。
    await expect(readFile(path.join(dir, 'MEMORY.md'), 'utf8')).rejects.toThrow();
  });

  it('dedups against existing content and within the batch (no duplicate writes)', async () => {
    const dir = await tempDir();
    await appendAgentNotes(dir, 'memory', [{ section: '项目约定', note: 'repo uses g- prefix' }]);
    const added = await appendAgentNotes(dir, 'memory', [
      { section: '项目约定', note: 'repo uses g- prefix' },
      { section: '项目约定', note: 'new fact' },
      { section: '其他', note: 'new fact' },
    ]);
    expect(added).toEqual(['new fact']); // 已存在的 / 批内重复的被跳过（去重只看正文）
    const content = await readFile(path.join(dir, 'MEMORY.md'), 'utf8');
    expect(content.match(/repo uses g- prefix/g)).toHaveLength(1);
    expect(content.match(/new fact/g)).toHaveLength(1);
  });

  it('returns empty for blank input without writing', async () => {
    const dir = await tempDir();
    const added = await appendAgentNotes(dir, 'user', [
      { section: 'x', note: '' },
      { section: 'x', note: '   ' },
    ]);
    expect(added).toEqual([]);
  });
});
