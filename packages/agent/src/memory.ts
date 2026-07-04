import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveAgentPaths } from './agent-files.js';

/** Context files the Agent may write (SOUL.md is always read-only, never written). */
export type WritableAgentFile = 'user' | 'memory' | 'agents';

/** A single proactive memory note: must carry a target topic section, written to the end of the corresponding `## section`. */
export interface MemoryNote {
  /**
   * Target section heading (**without** the `## ` prefix). Matches an existing `## section` of the same name in the file → appended to the end of that section;
   * not present → creates that section at the end of the file. **Required** — an entry that cannot be filed under some topic is not durable memory and should not be recorded.
   */
  section: string;
  /** Entry body (already a durable statement after abstraction and generalization). */
  note: string;
}

/**
 * Insert bullets at the end of the `## heading` section (before the next markdown heading); if that heading does not exist,
 * create a new section at the end of the file. Returns the new content (pure string transform, no disk write).
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

  // Section end = the line of the next line-start markdown heading (# ~ ######), or the end of the file.
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  // Skip trailing blank lines of the section, insert after the last content line (keeping the blank-line spacing from the following section).
  let insertAt = end;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1]!.trim() === '') insertAt--;
  lines.splice(insertAt, 0, ...bullets);
  return lines.join('\n');
}

/**
 * Write the entries the Agent proactively noted into the specified writable context file by **topic section**:
 * - user   → USER.md: non-private user info (form of address / language / review-habit preferences)
 * - memory → MEMORY.md: long-term knowledge / repo facts
 * - agents → AGENTS.md: work conventions / review conventions (**append-only**, does not rewrite or delete existing red lines)
 *
 * Each entry must carry a `section`: matches an existing `## section` → appended to the end of that section; not present → creates that section at the end of the file. Filing entries into
 * topic sections rather than a single stacked area eases cross-session context management (abstraction and generalization are gated in the prompt; entries that cannot be filed are not durable memory and are not recorded).
 *
 * Never writes SOUL.md. Idempotent dedup: a body duplicated with existing content (substring hit) or duplicated within the batch is not appended again; returns the actually-added entry bodies.
 * The privacy boundary is gated in the prompt when generating notes (see planner Protocol); here it only handles sectioned disk writing and dedup.
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

  // Idempotent dedup: skip bodies duplicated with existing content (substring hit) or duplicated within the batch.
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

  // Group by target section, preserving the original order within each group.
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
