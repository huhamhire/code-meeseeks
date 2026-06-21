import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveAgentPaths } from './agent-files.js';

/** Agent 可写的上下文文件（SOUL.md 永远只读、绝不写）。 */
export type WritableAgentFile = 'user' | 'memory' | 'agents';

/** 单条主动记忆：必带目标专题章节，写入对应 `## section` 末尾。 */
export interface MemoryNote {
  /**
   * 目标章节标题（**不含** `## ` 前缀）。命中文件里已有的同名 `## 章节` → 追加到该节末尾；
   * 不存在 → 在文件末尾新建该节。**必填**——无法归入某个专题的条目不是耐久记忆、不应记录。
   */
  section: string;
  /** 条目正文（已是抽象归纳后的耐久陈述）。 */
  note: string;
}

/**
 * 把 bullets 插到 `## heading` 区段末尾（下一个 markdown 标题之前）；该标题不存在则在
 * 文件末尾新建一节。返回新内容（纯字符串变换，不落盘）。
 */
function insertUnderHeading(content: string, heading: string, notes: readonly string[]): string {
  const bullets = notes.map((n) => `- ${n}`);
  const lines = content.split('\n');
  const target = `## ${heading}`.toLowerCase();
  const headingIdx = lines.findIndex((l) => l.trim().toLowerCase() === target);

  if (headingIdx === -1) {
    const base = content.trimEnd();
    const prefix = base ? `${base}\n\n` : '';
    return `${prefix}## ${heading}\n${bullets.join('\n')}\n`;
  }

  // 区段末尾 = 下一个行首 markdown 标题（# ~ ######）所在行，或文件末。
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  // 跳过区段尾部空行，插在最后一条内容之后（保持与后续章节的空行间隔）。
  let insertAt = end;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1]!.trim() === '') insertAt--;
  lines.splice(insertAt, 0, ...bullets);
  return lines.join('\n');
}

/**
 * 把 Agent 主动记下的条目按**专题章节**写入指定可写上下文文件：
 * - user   → USER.md：非隐私的用户信息（称呼 / 语言 / 评审习惯偏好）
 * - memory → MEMORY.md：长期知识 / 仓库事实
 * - agents → AGENTS.md：工作规范 / 评审约定（**仅追加**，不改写、不删除既有红线）
 *
 * 每条必带 `section`：命中已有 `## 章节`→ 追加到该节末尾；不存在 → 文件末尾新建该节。把条目归到
 * 专题章节而非单一堆叠区，便于跨会话上下文管理（抽象归纳在提示词把关；无法归类的条目不是耐久记忆、不记录）。
 *
 * 绝不写 SOUL.md。幂等去重：正文与现有内容重复（子串命中）或批内重复的不再追加；返回实际新增的条目正文。
 * 隐私边界由提示词在生成 notes 时把关（见 planner Protocol）；此处只负责分节落盘与去重。
 */
export async function appendAgentNotes(
  agentDir: string,
  kind: WritableAgentFile,
  notes: readonly MemoryNote[],
): Promise<string[]> {
  const cleaned = (notes ?? [])
    .map((n) => ({ section: n.section.trim(), note: n.note.trim() }))
    .filter((n) => n.section && n.note);
  if (!agentDir || cleaned.length === 0) return [];

  const file = resolveAgentPaths(agentDir)[kind];
  let content = '';
  try {
    content = await readFile(file, 'utf8');
  } catch {
    content = '';
  }

  // 幂等去重：正文与现有内容重复（子串命中）或批内重复的跳过。
  const haystack = content.toLowerCase();
  const seen = new Set<string>();
  const fresh: typeof cleaned = [];
  for (const n of cleaned) {
    const key = n.note.toLowerCase();
    if (seen.has(key) || haystack.includes(key)) continue;
    seen.add(key);
    fresh.push(n);
  }
  if (fresh.length === 0) return [];

  // 按目标章节分组，保持各组内的原始顺序。
  const groups = new Map<string, string[]>();
  for (const n of fresh) {
    const bucket = groups.get(n.section);
    if (bucket) bucket.push(n.note);
    else groups.set(n.section, [n.note]);
  }

  let next = content;
  for (const [heading, bullets] of groups) {
    next = insertUnderHeading(next, heading, bullets);
  }

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, next, 'utf8');
  return fresh.map((n) => n.note);
}
