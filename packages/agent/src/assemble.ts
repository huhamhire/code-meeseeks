import type { Rule } from '@meebox/rules';
import type { AgentTodoItem, ToolCatalogEntry } from '@meebox/shared';
import { CACHE_BREAK } from './constants.js';
import type { AgentContext } from './types.js';

/** 当前 PR 的最小元数据（装配进上下文）。 */
export interface AssemblePrMeta {
  title: string;
  description?: string;
  targetBranch: string;
  /** 变更概况，如「12 files, +340/-58」。 */
  changeSummary?: string;
}

/** 当前会话快照：让 Agent 续上未完成的规划。 */
export interface AssembleSessionSnapshot {
  todo: AgentTodoItem[];
  progressNote?: string;
}

export interface AssembleInput {
  context: AgentContext;
  pr: AssemblePrMeta;
  toolCatalog: ToolCatalogEntry[];
  /** 命中的规则（按「上下文注入」次序注入正文）；无命中传 null。 */
  matchedRule?: Rule | null;
  /** 输出 / 记忆写入语言（解析后的 locale code；空 = 默认 en-US，见「语言行为指令」）。 */
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
 * 现读现装配：按「上下文注入」固定次序拼接系统上下文，并按缓存友好分两段：
 * - 全局稳定前缀（跨 PR/运行一致，置最前供 1h 缓存）：SOUL → AGENTS → 工具目录 → MEMORY → USER。
 * - PR/运行相关尾部（每次不同，置最后）：命中规则 → PR 元数据 → 会话快照 → 语言行为指令。
 * 两段间插 CACHE_BREAK；任一段为空则不插标记。空段跳过。
 */
export function assembleSystemContext(input: AssembleInput): string {
  const { context, pr, toolCatalog, matchedRule, language, session } = input;
  const { files } = context;

  const stable: Array<string | null> = [
    section('Soul', files.soul),
    section('Working agreement', files.agents),
    renderToolCatalog(toolCatalog),
    section('Memory', files.memory),
    section('User profile', files.user),
  ];
  const variable: Array<string | null> = [
    matchedRule ? section('Matched rule', matchedRule.instructions) : null,
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
