import type { Rule } from '@meebox/rules';

/** Agent 目录里四个上下文文件的正文（缺失文件 → 空串）。 */
export interface AgentContextFiles {
  /** SOUL.md：灵魂，Agent 只读、默认由模版规定。 */
  soul: string;
  /** AGENTS.md：工作规范与红线。 */
  agents: string;
  /** MEMORY.md：长期记忆（可写）。 */
  memory: string;
  /** USER.md：用户画像（可写）。 */
  user: string;
}

/** 一次执行装配所需的 Agent 上下文：文件正文 + 命中候选规则集。 */
export interface AgentContext {
  files: AgentContextFiles;
  /** <agentDir>/rules 下加载的规则，按 priority desc + path asc 预排序（见 @meebox/rules）。 */
  rules: Rule[];
}

export interface LoadAgentContextOptions {
  /** 单文件读取 / 规则解析失败的告警回调（不阻断装配）。 */
  onWarn?: (msg: string, file?: string) => void;
}
