import { describe, expect, it } from 'vitest';
import { combineRuleInstructions, pickMatchingRule, pickMatchingRules, ruleMatches } from '../src/match.js';
import type { Rule, RuleMatchContext } from '../src/types.js';

function mkRule(over: Partial<Rule> = {}): Rule {
  return {
    id: over.id ?? 'r.md',
    filePath: over.filePath ?? '/tmp/r.md',
    applies_to: over.applies_to ?? {},
    tools: over.tools ?? ['review'],
    custom_labels: over.custom_labels ?? [],
    priority: over.priority ?? 0,
    enabled: over.enabled ?? true,
    instructions: over.instructions ?? 'body',
  };
}

const ctx: RuleMatchContext = {
  projectKey: 'FX',
  repoSlug: 'fx-help',
  targetBranch: 'master',
  tool: 'review',
};

describe('ruleMatches', () => {
  it('frontmatter all omitted + enabled=true → matches anything', () => {
    expect(ruleMatches(mkRule(), ctx)).toBe(true);
  });

  it('enabled=false → never matches', () => {
    expect(ruleMatches(mkRule({ enabled: false }), ctx)).toBe(false);
  });

  it('tools does not include the current tool → no match', () => {
    expect(ruleMatches(mkRule({ tools: ['describe'] }), ctx)).toBe(false);
    expect(ruleMatches(mkRule({ tools: ['review'] }), ctx)).toBe(true);
  });

  it('project regex with exact anchors (^FX$) matches', () => {
    const r = mkRule({ applies_to: { project: /^FX$/ } });
    expect(ruleMatches(r, ctx)).toBe(true);
    expect(ruleMatches(r, { ...ctx, projectKey: 'FX-OTHER' })).toBe(false);
  });

  it('fuzzy project regex (FX) without anchors matches on substring', () => {
    const r = mkRule({ applies_to: { project: /FX/ } });
    expect(ruleMatches(r, { ...ctx, projectKey: 'PRE-FX-SUF' })).toBe(true);
  });

  it('repo regex matches', () => {
    const r = mkRule({ applies_to: { repo: /^fx-.*/ } });
    expect(ruleMatches(r, ctx)).toBe(true);
    expect(ruleMatches(r, { ...ctx, repoSlug: 'other-help' })).toBe(false);
  });

  it('target_branch multi-choice regex matches', () => {
    const r = mkRule({ applies_to: { target_branch: /^(master|main)$/ } });
    expect(ruleMatches(r, ctx)).toBe(true);
    expect(ruleMatches(r, { ...ctx, targetBranch: 'main' })).toBe(true);
    expect(ruleMatches(r, { ...ctx, targetBranch: 'develop' })).toBe(false);
  });

  it('multiple fields set at once: any one not matching makes the whole thing false', () => {
    const r = mkRule({
      applies_to: { project: /^FX$/, repo: /^fx-other$/ },
    });
    expect(ruleMatches(r, ctx)).toBe(false); // project ok, repo no
  });
});

describe('pickMatchingRule', () => {
  it('with multiple matches takes the first by list order (caller pre-sorts before passing in)', () => {
    const rules = [
      mkRule({ id: '01.md' }),
      mkRule({ id: '02.md' }),
    ];
    expect(pickMatchingRule(rules, ctx)?.id).toBe('01.md');
  });

  it('returns null when nothing matches', () => {
    const rules = [mkRule({ applies_to: { project: /^OTHER$/ } })];
    expect(pickMatchingRule(rules, ctx)).toBeNull();
  });

  it('enabled=false rules are skipped, continuing to the next', () => {
    const rules = [
      mkRule({ id: 'a.md', enabled: false }),
      mkRule({ id: 'b.md' }),
    ];
    expect(pickMatchingRule(rules, ctx)?.id).toBe('b.md');
  });

  it('rules whose tool does not match are skipped', () => {
    const rules = [
      mkRule({ id: 'desc-only.md', tools: ['describe'] }),
      mkRule({ id: 'review-ok.md', tools: ['review'] }),
    ];
    expect(pickMatchingRule(rules, ctx)?.id).toBe('review-ok.md');
  });
});

describe('pickMatchingRules', () => {
  it('returns all matches (order preserved), filtering out non-matching / disabled ones', () => {
    const rules = [
      mkRule({ id: 'a.md' }),
      mkRule({ id: 'b.md', enabled: false }),
      mkRule({ id: 'c.md', tools: ['describe'] }),
      mkRule({ id: 'd.md' }),
    ];
    expect(pickMatchingRules(rules, ctx).map((r) => r.id)).toEqual(['a.md', 'd.md']);
  });

  it('caps at limit entries (takes the first N by list order)', () => {
    const rules = [mkRule({ id: '1.md' }), mkRule({ id: '2.md' }), mkRule({ id: '3.md' })];
    expect(pickMatchingRules(rules, ctx, 2).map((r) => r.id)).toEqual(['1.md', '2.md']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(pickMatchingRules([mkRule({ applies_to: { project: /^OTHER$/ } })], ctx)).toEqual([]);
  });
});

describe('combineRuleInstructions', () => {
  it('concatenates each rule body in Ruleset N sections (frontmatter already stripped at load time)', () => {
    const out = combineRuleInstructions([
      mkRule({ instructions: 'first body' }),
      mkRule({ instructions: 'second body' }),
    ]);
    expect(out).toBe('## Ruleset 1\n\nfirst body\n\n## Ruleset 2\n\nsecond body');
  });

  it('empty input → empty string', () => {
    expect(combineRuleInstructions([])).toBe('');
  });
});
