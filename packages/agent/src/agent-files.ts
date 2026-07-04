import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadRules } from '@meebox/rules';
import type { Rule } from '@meebox/rules';
import soul from '../resources/template/SOUL.md?raw';
import agents from '../resources/template/AGENTS.md?raw';
import memory from '../resources/template/MEMORY.md?raw';
import user from '../resources/template/USER.md?raw';
import readme from '../resources/template/README.md?raw';
import ruleExample from '../resources/template/rules/example.md?raw';
import { AGENT_FILES, AGENT_RULES_SUBDIR, EMPTY_FILES } from './constants.js';
import type { AgentContext, AgentContextFiles, LoadAgentContextOptions } from './types.js';

/**
 * Agent directory domain (see docs/arch/02-agent/01-agent.md「Agent 目录」): consolidates the
 * responsibilities of "on-disk agent files" — layout resolution / init templates / scaffolding /
 * live-read assembly (context + rules) — in one place. File-list constants (AGENT_FILES /
 * AGENT_RULES_SUBDIR) are in constants.ts; the memory **write** side (appendAgentNotes) is in memory.ts.
 */

// ── layout ──

export type AgentContextKind = keyof typeof AGENT_FILES;

/** Given agentDir, resolve the absolute paths of each context file and the rules directory. */
export function resolveAgentPaths(agentDir: string): {
  soul: string;
  agents: string;
  memory: string;
  user: string;
  rulesDir: string;
} {
  return {
    soul: path.join(agentDir, AGENT_FILES.soul),
    agents: path.join(agentDir, AGENT_FILES.agents),
    memory: path.join(agentDir, AGENT_FILES.memory),
    user: path.join(agentDir, AGENT_FILES.user),
    rulesDir: path.join(agentDir, AGENT_RULES_SUBDIR),
  };
}

// ── init templates ──

/**
 * Agent directory init templates (uniformly **en-US**, no i18n, see docs/arch/02-agent/01-agent.md「提示词模版」).
 * Template bodies are standalone `.md` resource files under `resources/`, inlined at build time via Vite `?raw`;
 * this file keeps only the **load/manifest logic**.
 *
 * Three ownership kinds:
 * - User-owned (`managed` omitted): AGENTS / MEMORY / USER / README — created if missing, not overwritten if present,
 *   users may freely rewrite them (including into a target language); the Agent may also append to some via the memory mechanism.
 * - App-owned (`managed: true`): `SOUL.md` — issued uniformly by the app, **forcibly aligned to the built-in template on load**,
 *   local edits are not preserved, so Agent behavior updates can be pushed uniformly across versions. Neither the Agent nor the user
 *   should rewrite it (edits will be aligned back to the template on the next load).
 * - Seed-once (`seedOnce: true`): `rules/example.md` — an example is written only on the Agent directory's **first scaffold**,
 *   never replenished afterward: once the user deletes it, it is gone permanently (the example is not a required file and should not be "revived" on every startup).
 */
export interface AgentTemplate {
  /** File path relative to agentDir. */
  path: string;
  contents: string;
  /** App-owned: forcibly aligned to the template on each scaffold (overwrites local edits). Defaults to user-owned, created only when missing. */
  managed?: boolean;
  /** Seed-once: created only once on the Agent directory's first scaffold, not replenished after deletion (mutually exclusive with `managed`). */
  seedOnce?: boolean;
}

/**
 * Default template manifest:
 * - User-owned created if missing (idempotent, no overwrite): AGENTS / MEMORY / USER / README;
 * - App-owned (SOUL) forcibly aligned to the template;
 * - Seed-once (rules/example.md) written only on the first scaffold, not replenished after deletion.
 */
export const AGENT_TEMPLATES: AgentTemplate[] = [
  { path: 'SOUL.md', contents: soul, managed: true },
  { path: 'AGENTS.md', contents: agents },
  { path: 'MEMORY.md', contents: memory },
  { path: 'USER.md', contents: user },
  { path: 'README.md', contents: readme },
  { path: 'rules/example.md', contents: ruleExample, seedOnce: true },
];

// ── scaffolding ──

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scaffold / align agentDir: ensure the rules/ subdirectory exists, and handle templates by ownership —
 * - User-owned: created if missing, not overwritten if present (idempotent).
 * - App-owned (managed, e.g. SOUL.md): forcibly aligned to the built-in template — created if missing, overwritten back to the template if present but drifted.
 * - Seed-once (seedOnce, e.g. rules/example.md): created only on the Agent directory's first scaffold, not replenished afterward (deletion is permanent).
 *
 * "First scaffold" is determined by whether the `rules/` subdirectory already exists: it is created by the first scaffold and persists thereafter (agentDir itself is
 * pre-created by bootstrap and cannot serve as the criterion). Returns the list of relative paths of files **actually written this time** (created or aligned); returns an empty array when nothing is written.
 * See docs/arch/02-agent/01-agent.md「提示词模版」.
 */
export async function scaffoldAgentDir(agentDir: string): Promise<string[]> {
  if (!agentDir) throw new Error('scaffoldAgentDir: agentDir must not be empty');
  const rulesDir = path.join(agentDir, AGENT_RULES_SUBDIR);
  const firstInit = !(await exists(rulesDir));
  await mkdir(rulesDir, { recursive: true });

  const written: string[] = [];
  for (const tpl of AGENT_TEMPLATES) {
    // Seed-once file: written only on the first scaffold, skipped thereafter (rules/ already exists) — not revived after deletion.
    if (tpl.seedOnce && !firstInit) continue;
    const abs = path.join(agentDir, tpl.path);
    if (await exists(abs)) {
      // User-owned: keep local contents. App-owned: skip if contents match the template, overwrite to align if drifted.
      if (!tpl.managed) continue;
      const current = await readFile(abs, 'utf8').catch(() => null);
      if (current === tpl.contents) continue;
    } else {
      await mkdir(path.dirname(abs), { recursive: true });
    }
    await writeFile(abs, tpl.contents, 'utf8');
    written.push(tpl.path);
  }
  return written;
}

// ── live-read assembly (context + rules) ──

/** Read a single context file; missing (ENOENT) → empty string, other read failures → warn + empty string (fail-safe). */
async function readOptional(
  file: string,
  onWarn?: LoadAgentContextOptions['onWarn'],
): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') onWarn?.(`读取失败：${e.message}`, file);
    return '';
  }
}

/**
 * Live read and assemble: on each execution re-read the Agent directory's SOUL / AGENTS / MEMORY / USER and rules/,
 * **no caching** (see docs/arch/02-agent/01-agent.md「上下文注入」). Empty agentDir → all-empty context (Agent degrades to native).
 */
export async function loadAgentContext(
  agentDir: string,
  opts: LoadAgentContextOptions = {},
): Promise<AgentContext> {
  if (!agentDir) return { files: { ...EMPTY_FILES }, rules: [] };

  const p = resolveAgentPaths(agentDir);
  const [soulText, agentsText, memoryText, userText, rules] = await Promise.all([
    readOptional(p.soul, opts.onWarn),
    readOptional(p.agents, opts.onWarn),
    readOptional(p.memory, opts.onWarn),
    readOptional(p.user, opts.onWarn),
    loadRules(p.rulesDir, { onWarn: opts.onWarn }),
  ]);
  const files: AgentContextFiles = {
    soul: soulText,
    agents: agentsText,
    memory: memoryText,
    user: userText,
  };
  return { files, rules };
}

/**
 * Load only the rules (`<agentDir>/rules`), for the injection path that "live-reads the first matching rule" —
 * no need to read SOUL/AGENTS and other context files. Empty agentDir → empty array.
 */
export async function loadAgentRules(
  agentDir: string,
  opts: LoadAgentContextOptions = {},
): Promise<Rule[]> {
  if (!agentDir) return [];
  return loadRules(resolveAgentPaths(agentDir).rulesDir, { onWarn: opts.onWarn });
}
