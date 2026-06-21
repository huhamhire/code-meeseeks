import { readFile } from 'node:fs/promises';
import { loadRules } from '@meebox/rules';
import type { Rule } from '@meebox/rules';
import { EMPTY_FILES } from './constants.js';
import { resolveAgentPaths } from './layout.js';
import type { AgentContext, AgentContextFiles, LoadAgentContextOptions } from './types.js';

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
  const [soul, agents, memory, user, rules] = await Promise.all([
    readOptional(p.soul, opts.onWarn),
    readOptional(p.agents, opts.onWarn),
    readOptional(p.memory, opts.onWarn),
    readOptional(p.user, opts.onWarn),
    loadRules(p.rulesDir, { onWarn: opts.onWarn }),
  ]);
  const files: AgentContextFiles = { soul, agents, memory, user };
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
