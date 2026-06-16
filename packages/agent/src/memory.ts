import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveAgentPaths } from './layout.js';

/** Agent 可写的上下文文件（SOUL.md 永远只读、绝不写）。 */
export type WritableAgentFile = 'user' | 'memory' | 'agents';

/** 各可写文件中由 Agent 自动维护的记录区标题（复用同一区，不重复建标题）。 */
const NOTE_HEADING = '## Agent 记录';

/**
 * 把 Agent 主动记下的条目**追加**到指定可写上下文文件：
 * - user   → USER.md：非隐私的用户信息（称呼 / 语言 / 评审习惯偏好）
 * - memory → MEMORY.md：长期知识 / 仓库事实
 * - agents → AGENTS.md：工作规范 / 评审约定（**仅追加**，不改写、不删除既有红线）
 *
 * 绝不写 SOUL.md。幂等去重：与现有正文重复（子串命中）的不再追加；返回实际新增条目。
 * 隐私边界由提示词在生成 notes 时把关（见 planner Protocol）；此处只负责落盘与去重。
 */
export async function appendAgentNotes(
  agentDir: string,
  kind: WritableAgentFile,
  notes: readonly string[],
): Promise<string[]> {
  const cleaned = notes.map((n) => n.trim()).filter(Boolean);
  if (!agentDir || cleaned.length === 0) return [];

  const file = resolveAgentPaths(agentDir)[kind];
  let content = '';
  try {
    content = await readFile(file, 'utf8');
  } catch {
    content = '';
  }

  const haystack = content.toLowerCase();
  const fresh: string[] = [];
  const seen = new Set<string>();
  for (const note of cleaned) {
    const key = note.toLowerCase();
    if (seen.has(key) || haystack.includes(key)) continue;
    seen.add(key);
    fresh.push(note);
  }
  if (fresh.length === 0) return [];

  let next = content;
  if (!next.includes(NOTE_HEADING)) {
    next = `${next.trimEnd()}${next.trim() ? '\n\n' : ''}${NOTE_HEADING}\n`;
  }
  next = `${next.trimEnd()}\n${fresh.map((n) => `- ${n}`).join('\n')}\n`;

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, next, 'utf8');
  return fresh;
}
