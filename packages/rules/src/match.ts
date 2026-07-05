import { DEFAULT_MAX_MATCHED_RULES, type Rule, type RuleMatchContext } from './types.js';

/**
 * Determine whether a single rule matches the PR context. Semantics:
 * - enabled=false → no match
 * - tools does not include the current tool → no match
 * - applies_to.<field> omitted → treated as matching anything; present → field value must pass regex.test()
 *
 * Return false immediately if any field fails to match (short-circuit).
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
 * Take all rules matched for the same PR, by priority desc + filePath asc (loadRules already pre-sorted, so order is
 * preserved), capped at `limit` rules (default {@link DEFAULT_MAX_MATCHED_RULES}) as a safety fallback; those beyond
 * the cap are dropped from the end per the sort order. The bodies of multiple rules are concatenated and injected by
 * the caller via {@link combineRuleInstructions}.
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
 * Take the **first** matched rule (priority desc + filePath asc). Still used for UI single-rule preview etc.; review
 * injection uses {@link pickMatchingRules} to take multiple.
 */
export function pickMatchingRule(rules: ReadonlyArray<Rule>, ctx: RuleMatchContext): Rule | null {
  return rules.find((r) => ruleMatches(r, ctx)) ?? null;
}

/**
 * Concatenate the bodies of multiple matched rules into a single injection text. Each rule contributes only its body
 * (frontmatter was already stripped by gray-matter at load time, so it won't leak into instructions); rules are
 * separated by `## Ruleset N` section headings, so the model can distinguish different specs without cross-contamination.
 * A single rule also gets a `## Ruleset 1` header for consistency. Empty input → empty string.
 */
export function combineRuleInstructions(rules: ReadonlyArray<Rule>): string {
  return rules
    .map((r, i) => `## Ruleset ${String(i + 1)}\n\n${r.instructions.trim()}`)
    .join('\n\n')
    .trim();
}
