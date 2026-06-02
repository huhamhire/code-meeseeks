import type { Rule, RuleMatchContext } from './types.js';

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
 * 同一 PR 多条规则命中时，按 priority desc + filePath asc 取**第一条**。
 * 这是用户明确选择的语义：rules 之间不拼接，避免 prompt 膨胀 + 互相矛盾。
 * 如果想生效更具体的规则，让作者把它 priority 调高（或 id 排在前面）。
 *
 * 调用方：loadRules() 已经按相同顺序排过，直接 .find() 即可，无需再排。
 */
export function pickMatchingRule(rules: ReadonlyArray<Rule>, ctx: RuleMatchContext): Rule | null {
  return rules.find((r) => ruleMatches(r, ctx)) ?? null;
}
