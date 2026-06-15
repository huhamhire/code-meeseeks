import { readFile } from 'node:fs/promises';
import { loadRules } from '@meebox/rules';
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

const EMPTY_FILES: AgentContextFiles = { soul: '', agents: '', memory: '', user: '' };

/**
 * 现读现装配：每次执行重新读 Agent 目录的 SOUL / AGENTS / MEMORY / USER 与 rules/，
 * **无缓存**（见 docs/arch/06-agent.md §2）。空 agentDir → 全空上下文（Agent 退化为原生）。
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
