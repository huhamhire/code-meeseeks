import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadRules } from '@meebox/rules';
import type { Rule } from '@meebox/rules';
import soul from '../resources/template/SOUL.md?raw';
import agents from '../resources/template/AGENTS.md?raw';
import memory from '../resources/template/MEMORY.md?raw';
import user from '../resources/template/USER.md?raw';
import readme from '../resources/template/README.md?raw';
import ruleExample from '../resources/template/rules/example.md?raw';
import { AGENT_FILES, AGENT_RULES_SUBDIR, EMPTY_FILES } from './constants.js';
import type { AgentContext, AgentContextFiles, LoadAgentContextOptions } from './types.js';

/**
 * Agent 目录域（见 docs/arch/02-agent/01-agent.md「Agent 目录」）：把同属「on-disk agent 文件」职责的
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
 * Agent 目录初始化模版（统一 **en-US**、不做 i18n，见 docs/arch/02-agent/01-agent.md「提示词模版」）。
 * 模版正文是 `resources/` 下的独立 `.md` 资源文件，构建期经 Vite `?raw` 内联；本文件只保留**加载/清单逻辑**。
 *
 * 三类所有权：
 * - 用户所有（`managed` 缺省）：AGENTS / MEMORY / USER / README——缺失即创建，已存在不覆盖，用户可自由改写
 *   （含改成目标语言）；Agent 亦可经记忆机制追写其中部分。
 * - 应用所有（`managed: true`）：`SOUL.md`——由应用统一下发，**加载时强制对齐内置模版**，不保留本地改动，
 *   以便随版本统一推送 Agent 行为更新。Agent 与用户都不应改写它（改了也会在下次加载被对齐回模版）。
 * - 首次播种（`seedOnce: true`）：`rules/example.md`——仅在 Agent 目录**首次脚手架**时落地一份示例，
 *   之后绝不补齐：用户删掉即永久消失（示例非必需文件，不应每次启动被「复活」）。
 */
export interface AgentTemplate {
  /** 相对 agentDir 的文件路径。 */
  path: string;
  contents: string;
  /** 应用所有：每次脚手架强制对齐到模版（覆盖本地改动）。缺省为用户所有，仅缺失时创建。 */
  managed?: boolean;
  /** 首次播种：仅 Agent 目录首次脚手架时创建一次，删除后不再补齐（与 `managed` 互斥）。 */
  seedOnce?: boolean;
}

/**
 * 默认模版清单：
 * - 用户所有缺失即创建（幂等、不覆盖）：AGENTS / MEMORY / USER / README；
 * - 应用所有（SOUL）强制对齐模版；
 * - 首次播种（rules/example.md）仅首次脚手架落地、删除后不补。
 */
export const AGENT_TEMPLATES: AgentTemplate[] = [
  { path: 'SOUL.md', contents: soul, managed: true },
  { path: 'AGENTS.md', contents: agents },
  { path: 'MEMORY.md', contents: memory },
  { path: 'USER.md', contents: user },
  { path: 'README.md', contents: readme },
  { path: 'rules/example.md', contents: ruleExample, seedOnce: true },
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
 * 脚手架 / 对齐 agentDir：确保 rules/ 子目录存在，并按所有权处理模版——
 * - 用户所有：缺失即创建，已存在不覆盖（幂等）。
 * - 应用所有（managed，如 SOUL.md）：强制对齐内置模版——缺失则创建，已存在但内容漂移则覆盖回模版。
 * - 首次播种（seedOnce，如 rules/example.md）：仅 Agent 目录首次脚手架时创建，之后不补（删除即永久消失）。
 *
 * 「首次脚手架」以 `rules/` 子目录是否已存在判定：它由首次脚手架建立、之后长存（agentDir 本身由 bootstrap
 * 预创建，不能作判据）。返回**本次实际写入**（新建或对齐）的文件相对路径列表；无写入返回空数组。
 * 见 docs/arch/02-agent/01-agent.md「提示词模版」。
 */
export async function scaffoldAgentDir(agentDir: string): Promise<string[]> {
  if (!agentDir) throw new Error('scaffoldAgentDir: agentDir must not be empty');
  const rulesDir = path.join(agentDir, AGENT_RULES_SUBDIR);
  const firstInit = !(await exists(rulesDir));
  await mkdir(rulesDir, { recursive: true });

  const written: string[] = [];
  for (const tpl of AGENT_TEMPLATES) {
    // 首次播种文件：仅首次脚手架落地，之后（rules/ 已存在）一律跳过——删除后不复活。
    if (tpl.seedOnce && !firstInit) continue;
    const abs = path.join(agentDir, tpl.path);
    if (await exists(abs)) {
      // 用户所有：保留本地内容。应用所有：内容与模版一致则跳过，漂移则覆盖对齐。
      if (!tpl.managed) continue;
      const current = await readFile(abs, 'utf8').catch(() => null);
      if (current === tpl.contents) continue;
    } else {
      await mkdir(path.dirname(abs), { recursive: true });
    }
    await writeFile(abs, tpl.contents, 'utf8');
    written.push(tpl.path);
  }
  return written;
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
 * **无缓存**（见 docs/arch/02-agent/01-agent.md「上下文注入」）。空 agentDir → 全空上下文（Agent 退化为原生）。
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
