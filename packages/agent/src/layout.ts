import path from 'node:path';

/**
 * Agent 目录的固定文件布局（见 docs/arch/06-agent.md §1）。
 * - SOUL.md  灵魂：核心职责与边界（Agent 只读，默认由模版规定）
 * - AGENTS.md 工作规范与红线
 * - MEMORY.md 长期记忆（可写）
 * - USER.md  用户画像（可写）
 */
export const AGENT_FILES = {
  soul: 'SOUL.md',
  agents: 'AGENTS.md',
  memory: 'MEMORY.md',
  user: 'USER.md',
} as const;

/** rules/ 子目录名：规则正文存放处，匹配语义见 @meebox/rules（docs/arch/07-rules.md）。 */
export const AGENT_RULES_SUBDIR = 'rules';

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
