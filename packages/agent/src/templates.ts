import soul from '../resources/template/SOUL.md?raw';
import agents from '../resources/template/AGENTS.md?raw';
import memory from '../resources/template/MEMORY.md?raw';
import user from '../resources/template/USER.md?raw';
import ruleExample from '../resources/template/rules/example.md?raw';

/**
 * Agent 目录初始化模版（统一 **en-US**、不做 i18n，见 docs/arch/06-agent.md「提示词模版」）。
 * 模版正文是 `resources/` 下的独立 `.md` 资源文件，构建期经 Vite `?raw` 内联；
 * 本文件只保留**加载/清单逻辑**。用户初始化后可自由改写成目标语言；
 * `SOUL.md` 默认完全由本模版规定、Agent 无权改写。
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
