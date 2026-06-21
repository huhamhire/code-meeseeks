import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadRules } from '@meebox/rules';
import type { Rule } from '@meebox/rules';
import soul from '../resources/template/SOUL.md?raw';
import agents from '../resources/template/AGENTS.md?raw';
import memory from '../resources/template/MEMORY.md?raw';
import user from '../resources/template/USER.md?raw';
import ruleExample from '../resources/template/rules/example.md?raw';
import { AGENT_FILES, AGENT_RULES_SUBDIR, EMPTY_FILES } from './constants.js';
import type { AgentContext, AgentContextFiles, LoadAgentContextOptions } from './types.js';

/**
 * Agent 目录域（见 docs/arch/06-agent.md「Agent 目录」）：把同属「on-disk agent 文件」职责的
 * 布局解析 / 初始化模版 / 脚手架 / 现读装配（上下文 + 规则）收口到一处。文件清单常量（AGENT_FILES /
 * AGENT_RULES_SUBDIR）见 constants.ts；记忆**写入**侧（appendAgentNotes）在 memory.ts。
 */

// ── 布局 ──

export type AgentContextKind = keyof typeof AGENT_FILES;

/** 给定 agentDir，解析各上下文文件与 rules 目录的绝对路径。 */
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

// ── 初始化模版 ──

/**
 * Agent 目录初始化模版（统一 **en-US**、不做 i18n，见 docs/arch/06-agent.md「提示词模版」）。
 * 模版正文是 `resources/` 下的独立 `.md` 资源文件，构建期经 Vite `?raw` 内联；本文件只保留**加载/清单逻辑**。
 * 用户初始化后可自由改写成目标语言；`SOUL.md` 默认完全由本模版规定、Agent 无权改写。
 */
export interface AgentTemplate {
  /** 相对 agentDir 的文件路径。 */
  path: string;
  contents: string;
}

/** 默认模版清单：缺失即创建（幂等），已存在不覆盖。 */
export const AGENT_TEMPLATES: AgentTemplate[] = [
  { path: 'SOUL.md', contents: soul },
  { path: 'AGENTS.md', contents: agents },
  { path: 'MEMORY.md', contents: memory },
  { path: 'USER.md', contents: user },
  { path: 'rules/example.md', contents: ruleExample },
];

// ── 脚手架 ──

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 幂等脚手架：把缺失的模版文件写入 agentDir（已存在不覆盖），并确保 rules/ 子目录存在。
 * 返回**实际创建**的文件相对路径列表（已存在的不计）。见 docs/arch/06-agent.md「提示词模版」。
 */
export async function scaffoldAgentDir(agentDir: string): Promise<string[]> {
  if (!agentDir) throw new Error('scaffoldAgentDir: agentDir must not be empty');
  await mkdir(path.join(agentDir, AGENT_RULES_SUBDIR), { recursive: true });

  const created: string[] = [];
  for (const tpl of AGENT_TEMPLATES) {
    const abs = path.join(agentDir, tpl.path);
    if (await exists(abs)) continue;
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, tpl.contents, 'utf8');
    created.push(tpl.path);
  }
  return created;
}

// ── 现读装配（上下文 + 规则）──

/** 读单个上下文文件；缺失（ENOENT）→ 空串，其它读失败 → 告警 + 空串（失败安全）。 */
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
 * 现读现装配：每次执行重新读 Agent 目录的 SOUL / AGENTS / MEMORY / USER 与 rules/，
 * **无缓存**（见 docs/arch/06-agent.md「上下文注入」）。空 agentDir → 全空上下文（Agent 退化为原生）。
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
 * 只加载规则（`<agentDir>/rules`），供「现读取首条命中规则」的注入路径用——无需读
 * SOUL/AGENTS 等上下文文件。空 agentDir → 空数组。
 */
export async function loadAgentRules(
  agentDir: string,
  opts: LoadAgentContextOptions = {},
): Promise<Rule[]> {
  if (!agentDir) return [];
  return loadRules(resolveAgentPaths(agentDir).rulesDir, { onWarn: opts.onWarn });
}
