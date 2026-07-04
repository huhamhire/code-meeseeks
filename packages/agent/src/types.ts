import type { Rule } from '@meebox/rules';

/** Bodies of the four context files in the Agent directory (missing file → empty string). */
export interface AgentContextFiles {
  /** SOUL.md: the soul; read-only to the Agent, specified by the template by default. */
  soul: string;
  /** AGENTS.md: work conventions and red lines. */
  agents: string;
  /** MEMORY.md: long-term memory (writable). */
  memory: string;
  /** USER.md: user profile (writable). */
  user: string;
}

/** Agent context needed to assemble a single execution: file bodies + the matched candidate rule set. */
export interface AgentContext {
  files: AgentContextFiles;
  /** Rules loaded from <agentDir>/rules, pre-sorted by priority desc + path asc (see @meebox/rules). */
  rules: Rule[];
}

export interface LoadAgentContextOptions {
  /** Warning callback for single-file read / rule parse failures (does not block assembly). */
  onWarn?: (msg: string, file?: string) => void;
}
