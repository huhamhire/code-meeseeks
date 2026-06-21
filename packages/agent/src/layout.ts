import path from 'node:path';
import { AGENT_FILES, AGENT_RULES_SUBDIR } from './constants.js';

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
