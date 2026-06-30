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
  it('frontmatter 全省 + enabled=true → 匹配任意', () => {
    expect(ruleMatches(mkRule(), ctx)).toBe(true);
  });

  it('enabled=false → 永远不匹配', () => {
    expect(ruleMatches(mkRule({ enabled: false }), ctx)).toBe(false);
  });

  it('tools 不含当前 tool → 不匹配', () => {
    expect(ruleMatches(mkRule({ tools: ['describe'] }), ctx)).toBe(false);
    expect(ruleMatches(mkRule({ tools: ['review'] }), ctx)).toBe(true);
  });

  it('project 正则精确锚 (^FX$) 命中', () => {
    const r = mkRule({ applies_to: { project: /^FX$/ } });
    expect(ruleMatches(r, ctx)).toBe(true);
    expect(ruleMatches(r, { ...ctx, projectKey: 'FX-OTHER' })).toBe(false);
  });

  it('project 正则模糊 (FX) 不锚时会子串命中', () => {
    const r = mkRule({ applies_to: { project: /FX/ } });
    expect(ruleMatches(r, { ...ctx, projectKey: 'PRE-FX-SUF' })).toBe(true);
  });

  it('repo 正则命中', () => {
    const r = mkRule({ applies_to: { repo: /^fx-.*/ } });
    expect(ruleMatches(r, ctx)).toBe(true);
    expect(ruleMatches(r, { ...ctx, repoSlug: 'other-help' })).toBe(false);
  });

  it('target_branch 多选正则命中', () => {
    const r = mkRule({ applies_to: { target_branch: /^(master|main)$/ } });
    expect(ruleMatches(r, ctx)).toBe(true);
    expect(ruleMatches(r, { ...ctx, targetBranch: 'main' })).toBe(true);
    expect(ruleMatches(r, { ...ctx, targetBranch: 'develop' })).toBe(false);
  });

  it('多字段同时设：任一不匹配整体 false', () => {
    const r = mkRule({
      applies_to: { project: /^FX$/, repo: /^fx-other$/ },
    });
    expect(ruleMatches(r, ctx)).toBe(false); // project ok, repo no
  });
});

describe('pickMatchingRule', () => {
  it('多条命中按列表顺序取第一条 (调用方传入时已经预排序)', () => {
    const rules = [
      mkRule({ id: '01.md' }),
      mkRule({ id: '02.md' }),
    ];
    expect(pickMatchingRule(rules, ctx)?.id).toBe('01.md');
  });

  it('全不命中返回 null', () => {
    const rules = [mkRule({ applies_to: { project: /^OTHER$/ } })];
    expect(pickMatchingRule(rules, ctx)).toBeNull();
  });

  it('enabled=false 的规则会被跳过，下一条继续', () => {
    const rules = [
      mkRule({ id: 'a.md', enabled: false }),
      mkRule({ id: 'b.md' }),
    ];
    expect(pickMatchingRule(rules, ctx)?.id).toBe('b.md');
  });

  it('tool 不匹配的规则会被跳过', () => {
    const rules = [
      mkRule({ id: 'desc-only.md', tools: ['describe'] }),
      mkRule({ id: 'review-ok.md', tools: ['review'] }),
    ];
    expect(pickMatchingRule(rules, ctx)?.id).toBe('review-ok.md');
  });
});

describe('pickMatchingRules', () => {
  it('返回全部命中（保序），过滤掉不匹配 / 禁用的', () => {
    const rules = [
      mkRule({ id: 'a.md' }),
      mkRule({ id: 'b.md', enabled: false }),
      mkRule({ id: 'c.md', tools: ['describe'] }),
      mkRule({ id: 'd.md' }),
    ];
    expect(pickMatchingRules(rules, ctx).map((r) => r.id)).toEqual(['a.md', 'd.md']);
  });

  it('封顶 limit 条（按列表顺序取前 N）', () => {
    const rules = [mkRule({ id: '1.md' }), mkRule({ id: '2.md' }), mkRule({ id: '3.md' })];
    expect(pickMatchingRules(rules, ctx, 2).map((r) => r.id)).toEqual(['1.md', '2.md']);
  });

  it('全不命中返回空数组', () => {
    expect(pickMatchingRules([mkRule({ applies_to: { project: /^OTHER$/ } })], ctx)).toEqual([]);
  });
});

describe('combineRuleInstructions', () => {
  it('按 Ruleset N 分段拼接各规则正文（frontmatter 已在加载期剥离）', () => {
    const out = combineRuleInstructions([
      mkRule({ instructions: 'first body' }),
      mkRule({ instructions: 'second body' }),
    ]);
    expect(out).toBe('## Ruleset 1\n\nfirst body\n\n## Ruleset 2\n\nsecond body');
  });

  it('空输入 → 空串', () => {
    expect(combineRuleInstructions([])).toBe('');
  });
});
