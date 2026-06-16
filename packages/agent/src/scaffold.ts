import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_RULES_SUBDIR } from './layout.js';
import { AGENT_TEMPLATES } from './templates.js';

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
  if (!agentDir) throw new Error('scaffoldAgentDir: agentDir 不能为空');
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
