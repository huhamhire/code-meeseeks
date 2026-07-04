import type { AgentTodoItem, ToolCatalogEntry } from '@meebox/shared';
import autopilotJudge from '../resources/prompts/autopilot-judge.md?raw';
import judge from '../resources/prompts/judge.md?raw';
import protocol from '../resources/prompts/protocol.md?raw';
import summary from '../resources/prompts/summary.md?raw';
import { CACHE_BREAK } from './constants.js';
import type { AgentContext } from './types.js';

/**
 * Prompt assembly domain (see docs/arch/02-agent/01-agent.md "prompt templates" "context injection"): both the static user-turn templates (PROMPT_TEMPLATES)
 * and the dynamic system context assembly (assembleSystemContext) belong to "constructing the prompt sent to the model" and converge here. Domain-agnostic string tools such as
 * placeholder filling / truncation are in utils.
 */

// ── Static user-turn templates ──

/**
 * Orchestrator prompt templates: static bodies are externalized into `.md` under `resources/prompts/`, inlined at build time via Vite `?raw`. Dynamic values use
 * `{{name}}` placeholders, injected by utils's fillTemplate; conditional concatenation and large dynamic content (describe/review text, PR list, etc.)
 * are still assembled on the TS side by each caller.
 */
export const PROMPT_TEMPLATES = {
  /** Planning ReAct protocol (action format / review summary skeleton / memory rules / plan / session scope). Placeholders: overview/findings/suggestions. */
  protocol,
  /** Follow-up judge user instruction (placeholders: maxAsks/language); describe/review body appended by the caller. */
  judge,
  /** Summary user instruction + three-section skeleton (placeholders: maxChars/overview/findings/suggestions); body appended by the caller. */
  summary,
  /** AutoPilot batch-judge system base (no placeholders); project rules appended by the caller as needed. */
  autopilotJudge,
} as const;

// ── Dynamic system context assembly ──

/** Minimal metadata for the current PR (assembled into the context). */
export interface AssemblePrMeta {
  title: string;
  description?: string;
  targetBranch: string;
  /** Change overview, e.g. "12 files, +340/-58". */
  changeSummary?: string;
}

/** Current session snapshot: lets the agent resume unfinished planning. */
export interface AssembleSessionSnapshot {
  todo: AgentTodoItem[];
  progressNote?: string;
}

export interface AssembleInput {
  context: AgentContext;
  pr: AssemblePrMeta;
  toolCatalog: ToolCatalogEntry[];
  /** Concatenated body of matched rules (multiple joined via combineRuleInstructions, incl. Ruleset sections); pass empty / null when nothing matched. */
  matchedRuleInstructions?: string | null;
  /** Output / memory-write language (resolved locale code; empty = default en-US, see "language behavior instruction"). */
  language?: string;
  session?: AssembleSessionSnapshot;
}

function section(title: string, body: string | undefined): string | null {
  const trimmed = (body ?? '').trim();
  return trimmed ? `# ${title}\n\n${trimmed}` : null;
}

function renderToolCatalog(tools: ToolCatalogEntry[]): string | null {
  if (tools.length === 0) return null;
  const lines = tools.map((t) => {
    const flags: string[] = [];
    if (t.mutating) flags.push('mutating');
    if (!t.enabled) flags.push('disabled — requires explicit authorization');
    const suffix = flags.length ? ` _(${flags.join('; ')})_` : '';
    return `- \`${t.name}\` — ${t.summary}${suffix}`;
  });
  return `# Available tools\n\n${lines.join('\n')}`;
}

function renderPr(pr: AssemblePrMeta): string {
  const parts = [`Title: ${pr.title}`, `Target branch: ${pr.targetBranch}`];
  if (pr.changeSummary) parts.push(`Changes: ${pr.changeSummary}`);
  if (pr.description?.trim()) parts.push(`\nDescription:\n${pr.description.trim()}`);
  return `# Current PR\n\n${parts.join('\n')}`;
}

function renderSession(snap: AssembleSessionSnapshot): string | null {
  const todoLines = snap.todo.map((it) => `- [${it.done ? 'x' : ' '}] ${it.text}`);
  const body = [
    todoLines.length ? `Tasks:\n${todoLines.join('\n')}` : '',
    snap.progressNote?.trim() ? `Progress:\n${snap.progressNote.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return body ? `# Current session\n\n${body}` : null;
}

function renderLanguage(language: string | undefined): string {
  const lang = (language ?? '').trim() || 'en-US';
  return [
    '# Output & memory language',
    '',
    `Respond to the user in ${lang}.`,
    `When appending new entries to MEMORY.md / USER.md, also write them in ${lang}.`,
  ].join('\n');
}

/**
 * Assemble on the fly: concatenate the system context in the fixed "context injection" order, split into two cache-friendly segments:
 * - Globally stable prefix (consistent across PRs/runs, placed first for 1h caching): SOUL → AGENTS → tool catalog → MEMORY → USER.
 * - PR/run-related tail (differs each time, placed last): matched rules → PR metadata → session snapshot → language behavior instruction.
 * Insert CACHE_BREAK between the two segments; if either segment is empty, do not insert the marker. Skip empty segments.
 */
export function assembleSystemContext(input: AssembleInput): string {
  const { context, pr, toolCatalog, matchedRuleInstructions, language, session } = input;
  const { files } = context;

  const stable: Array<string | null> = [
    section('Soul', files.soul),
    section('Working agreement', files.agents),
    renderToolCatalog(toolCatalog),
    section('Memory', files.memory),
    section('User profile', files.user),
  ];
  const variable: Array<string | null> = [
    matchedRuleInstructions ? section('Matched rules', matchedRuleInstructions) : null,
    renderPr(pr),
    session ? renderSession(session) : null,
    renderLanguage(language),
  ];

  const stableStr = stable.filter((b): b is string => b !== null).join('\n\n---\n\n');
  const variableStr = variable.filter((b): b is string => b !== null).join('\n\n---\n\n');
  if (!stableStr) return variableStr;
  if (!variableStr) return stableStr;
  return stableStr + CACHE_BREAK + variableStr;
}
