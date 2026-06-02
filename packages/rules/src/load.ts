import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { Rule, RuleTool } from './types.js';

const VALID_TOOLS: ReadonlyArray<RuleTool> = ['describe', 'review'];

/**
 * 递归扫 dir 下所有 .md，gray-matter 解析 frontmatter + body。
 * - 单个文件解析失败（frontmatter yaml 烂 / 必填字段类型错）→ 跳过该文件，throw-safe
 * - dir 不存在 / 不可读 → 返回空数组，由调用方决定是否提示
 * - 文件名 / 路径不限制，但建议小写 + 短横线 (UI 展示 id 用相对路径)
 *
 * 返回的 Rule 按 priority desc + filePath asc 预排序，调用方可以直接遍历找首条。
 */
export async function loadRules(
  dir: string,
  opts?: { onWarn?: (msg: string, file?: string) => void },
): Promise<Rule[]> {
  if (!dir) return [];
  const exists = await dirExists(dir);
  if (!exists) {
    opts?.onWarn?.(`rules.dir not found: ${dir}`);
    return [];
  }
  const files = await listMdFiles(dir);
  const rules: Rule[] = [];
  for (const filePath of files) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = matter(raw);
      const rule = buildRule(filePath, dir, parsed);
      if (rule) rules.push(rule);
    } catch (err) {
      opts?.onWarn?.(
        `failed to parse rule: ${err instanceof Error ? err.message : String(err)}`,
        filePath,
      );
    }
  }
  return sortRules(rules);
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function listMdFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        // 跳过隐藏目录 (.git / .vscode 等)
        if (e.name.startsWith('.')) continue;
        await walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

/** frontmatter 解析失败 / 字段类型不对时返回 null，由调用方记 warn 跳过 */
function buildRule(
  filePath: string,
  baseDir: string,
  parsed: matter.GrayMatterFile<string>,
): Rule | null {
  const data = parsed.data as Record<string, unknown>;
  const body = parsed.content.trim();

  // applies_to: 各字段都可省，省 = match anything (undefined regex)
  const appliesRaw =
    (data.applies_to as Record<string, unknown> | undefined) ?? {};
  const applies = {
    project: compileRegex(appliesRaw.project),
    repo: compileRegex(appliesRaw.repo),
    target_branch: compileRegex(appliesRaw.target_branch),
  };

  // tools: 默认只给 /review。规则的语义本来就是"代码评审规约"，给 /describe
  // (PR 描述生成) 注入约束会让描述偏题；想要规则同时影响 /describe 的用户显式
  // 写 tools: [describe, review]
  const toolsRaw = data.tools;
  let tools: ReadonlyArray<RuleTool> = ['review'];
  if (Array.isArray(toolsRaw)) {
    const filtered = toolsRaw.filter((t): t is RuleTool =>
      typeof t === 'string' && (VALID_TOOLS as readonly string[]).includes(t),
    );
    if (filtered.length > 0) tools = filtered;
  }

  // custom_labels: 容错成空数组
  const labelsRaw = data.custom_labels;
  const customLabels: string[] = Array.isArray(labelsRaw)
    ? labelsRaw.filter((x): x is string => typeof x === 'string')
    : [];

  const priority = typeof data.priority === 'number' ? data.priority : 0;
  const enabled = typeof data.enabled === 'boolean' ? data.enabled : true;

  return {
    id: path.relative(baseDir, filePath).replace(/\\/g, '/'),
    filePath,
    applies_to: applies,
    tools,
    custom_labels: customLabels,
    priority,
    enabled,
    instructions: body,
  };
}

function compileRegex(v: unknown): RegExp | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  try {
    // 用户写的是正则源串。不强制加锚 (^/$)，由规则文件作者自行决定
    return new RegExp(v);
  } catch {
    // 非法正则：当作未配置该字段，规则匹配时跳过；buildRule 不抛
    return undefined;
  }
}

function sortRules(rules: Rule[]): Rule[] {
  return rules
    .slice()
    .sort((a, b) => (b.priority - a.priority) || a.id.localeCompare(b.id));
}
