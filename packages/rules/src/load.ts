import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { MAX_RULE_FILES, type Rule, type RuleTool } from './types.js';

const VALID_TOOLS: ReadonlyArray<RuleTool> = ['describe', 'review'];

/**
 * Recursively scan all .md under dir, parse frontmatter + body via gray-matter.
 * - Single file parse failure (broken frontmatter yaml / required field type error) → skip that file, throw-safe
 * - dir missing / unreadable → return empty array, caller decides whether to prompt
 * - No restriction on file name / path, but lowercase + hyphen recommended (UI displays id as relative path)
 *
 * Returned Rule list is pre-sorted by priority desc + filePath asc, so callers can iterate directly to find the first.
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
  const files = await listMdFiles(dir, opts?.onWarn);
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

/**
 * Recursively collect all .md under dir (skipping hidden directories). Stop traversal and warn once the count
 * reaches {@link MAX_RULE_FILES} — a performance fallback interception for when the rules dir is mistakenly pointed at
 * a huge directory tree, avoiding scanning through a massive number of files in one load. Return order is the directory
 * traversal order; priority sorting is done uniformly inside loadRules (sortRules), so what truncation drops here are
 * the files "later in traversal", unrelated to priority (the match cap is separately gated by pickMatchingRules).
 */
async function listMdFiles(
  dir: string,
  onWarn?: (msg: string, file?: string) => void,
): Promise<string[]> {
  const out: string[] = [];
  let truncated = false;
  async function walk(d: string): Promise<void> {
    if (out.length >= MAX_RULE_FILES) return;
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (out.length >= MAX_RULE_FILES) {
        truncated = true;
        return;
      }
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        // skip hidden directories (.git / .vscode etc.)
        if (e.name.startsWith('.')) continue;
        await walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  if (truncated) {
    onWarn?.(`rules dir has more than ${String(MAX_RULE_FILES)} .md files; only the first scanned are loaded`);
  }
  return out;
}

/** Return null on frontmatter parse failure / wrong field type; caller logs warn and skips */
function buildRule(
  filePath: string,
  baseDir: string,
  parsed: matter.GrayMatterFile<string>,
): Rule | null {
  const data = parsed.data as Record<string, unknown>;
  const body = parsed.content.trim();

  // applies_to: every field is optional, omitted = match anything (undefined regex)
  const appliesRaw =
    (data.applies_to as Record<string, unknown> | undefined) ?? {};
  const applies = {
    project: compileRegex(appliesRaw.project),
    repo: compileRegex(appliesRaw.repo),
    target_branch: compileRegex(appliesRaw.target_branch),
  };

  // tools: defaults to only /review. A rule's semantics are inherently a "code review spec"; injecting
  // constraints into /describe (PR description generation) would derail the description; users who want a
  // rule to also affect /describe explicitly write tools: [describe, review]
  const toolsRaw = data.tools;
  let tools: ReadonlyArray<RuleTool> = ['review'];
  if (Array.isArray(toolsRaw)) {
    const filtered = toolsRaw.filter((t): t is RuleTool =>
      typeof t === 'string' && (VALID_TOOLS as readonly string[]).includes(t),
    );
    if (filtered.length > 0) tools = filtered;
  }

  // custom_labels: fall back to empty array on error
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
    // user writes a regex source string. No forced anchors (^/$); left to the rule file author to decide
    return new RegExp(v);
  } catch {
    // invalid regex: treat as if the field is not configured, skip during rule matching; buildRule does not throw
    return undefined;
  }
}

function sortRules(rules: Rule[]): Rule[] {
  return rules
    .slice()
    .sort((a, b) => (b.priority - a.priority) || a.id.localeCompare(b.id));
}
