import { DEFAULT_MAX_MATCHED_RULES, type Rule, type RuleMatchContext } from './types.js';

/**
 * 判断单条规则是否匹配 PR 上下文。语义：
 * - enabled=false → 不匹配
 * - tools 不含当前 tool → 不匹配
 * - applies_to.<field> 缺省 → 视为匹配任意；存在 → 字段值需通过 regex.test()
 *
 * 任一字段不匹配立刻返回 false (短路)。
 */
export function ruleMatches(rule: Rule, ctx: RuleMatchContext): boolean {
  if (!rule.enabled) return false;
  if (!rule.tools.includes(ctx.tool)) return false;
  const a = rule.applies_to;
  if (a.project && !a.project.test(ctx.projectKey)) return false;
  if (a.repo && !a.repo.test(ctx.repoSlug)) return false;
  if (a.target_branch && !a.target_branch.test(ctx.targetBranch)) return false;
  return true;
}

/**
 * 取同一 PR 命中的全部规则，按 priority desc + filePath asc（loadRules 已预排序，故保序），
 * 封顶 `limit` 条（默认 {@link DEFAULT_MAX_MATCHED_RULES}）作安全兜底，超出按排序丢弃靠后者。
 * 多条规则的正文由调用方经 {@link combineRuleInstructions} 拼接注入。
 */
export function pickMatchingRules(
  rules: ReadonlyArray<Rule>,
  ctx: RuleMatchContext,
  limit: number = DEFAULT_MAX_MATCHED_RULES,
): Rule[] {
  const matched = rules.filter((r) => ruleMatches(r, ctx));
  return limit >= 0 ? matched.slice(0, limit) : matched;
}

/**
 * 取命中规则的**首条**（priority desc + filePath asc）。UI 单条预览等仍用得到；评审注入走
 * {@link pickMatchingRules} 取多条。
 */
export function pickMatchingRule(rules: ReadonlyArray<Rule>, ctx: RuleMatchContext): Rule | null {
  return rules.find((r) => ruleMatches(r, ctx)) ?? null;
}

/**
 * 把多条命中规则的正文拼成单段注入文本。各规则只取 body（frontmatter 在加载期已被 gray-matter 剥离，
 * 不会泄漏进 instructions）；规则间以 `## Ruleset N` 分段标题分隔，便于模型区分不同规约、互不串味。
 * 单条时也加 `## Ruleset 1` 头以保持一致。空输入 → 空串。
 */
export function combineRuleInstructions(rules: ReadonlyArray<Rule>): string {
  return rules
    .map((r, i) => `## Ruleset ${String(i + 1)}\n\n${r.instructions.trim()}`)
    .join('\n\n')
    .trim();
}
