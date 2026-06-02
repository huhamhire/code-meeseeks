import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadRules } from '../src/load.js';
import type { Rule } from '../src/types.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-pilot-rules-test-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function write(rel: string, body: string): Promise<void> {
  const full = path.join(tmp, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body);
}

describe('loadRules', () => {
  it('空 dir 返回空数组', async () => {
    const rules = await loadRules('');
    expect(rules).toEqual([]);
  });

  it('dir 不存在调 onWarn 并返回空', async () => {
    const warns: string[] = [];
    const rules = await loadRules(path.join(tmp, 'no-such-dir'), {
      onWarn: (msg) => warns.push(msg),
    });
    expect(rules).toEqual([]);
    expect(warns[0]).toMatch(/not found/);
  });

  it('解析 frontmatter + body；缺省字段走默认', async () => {
    await write(
      'simple.md',
      `---
applies_to:
  project: "^FX$"
tools: [review]
priority: 10
---

# Foo

正文示例。
`,
    );
    const rules = await loadRules(tmp);
    expect(rules).toHaveLength(1);
    const r = rules[0]!;
    expect(r.id).toBe('simple.md');
    expect(r.applies_to.project).toBeInstanceOf(RegExp);
    expect(r.applies_to.project!.test('FX')).toBe(true);
    expect(r.applies_to.project!.test('OTHER')).toBe(false);
    expect(r.applies_to.repo).toBeUndefined();
    expect(r.tools).toEqual(['review']);
    expect(r.priority).toBe(10);
    expect(r.enabled).toBe(true);
    expect(r.instructions).toContain('# Foo');
    expect(r.instructions).toContain('正文示例');
  });

  it('递归扫描子目录，id 用相对路径', async () => {
    await write('a.md', '---\n---\n\nA');
    await write('sub/b.md', '---\n---\n\nB');
    await write('sub/nested/c.md', '---\n---\n\nC');
    const rules = await loadRules(tmp);
    const ids = rules.map((r) => r.id).sort();
    expect(ids).toEqual(['a.md', 'sub/b.md', 'sub/nested/c.md']);
  });

  it('跳过隐藏目录 (.git / .vscode)', async () => {
    await write('keep.md', '---\n---\n\nkeep');
    await write('.git/internal.md', '---\n---\n\nshouldnt-load');
    await write('.vscode/settings.md', '---\n---\n\nshouldnt-load');
    const rules = await loadRules(tmp);
    expect(rules.map((r) => r.id)).toEqual(['keep.md']);
  });

  it('非 .md 文件被忽略', async () => {
    await write('rule.md', '---\n---\n\nyes');
    await write('readme.txt', 'no');
    await write('notes.markdown', 'no');
    const rules = await loadRules(tmp);
    expect(rules.map((r) => r.id)).toEqual(['rule.md']);
  });

  it('frontmatter yaml 烂掉时调 onWarn 并跳过该文件，其他规则继续加载', async () => {
    await write('good.md', '---\napplies_to:\n  project: FX\n---\n\nok');
    await write('bad.md', '---\napplies_to: {invalid yaml [\n---\n\nbroken');
    const warns: string[] = [];
    const rules = await loadRules(tmp, { onWarn: (msg) => warns.push(msg) });
    expect(rules.map((r) => r.id)).toEqual(['good.md']);
    expect(warns.length).toBe(1);
  });

  it('非法正则源串视为该字段未配置，不抛', async () => {
    await write(
      'bad-regex.md',
      `---
applies_to:
  project: "["
---

body
`,
    );
    const rules = await loadRules(tmp);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.applies_to.project).toBeUndefined();
  });

  it('排序：priority desc 优先，tie-break 用 id asc', async () => {
    await write('aaa.md', '---\npriority: 5\n---\n\nA');
    await write('bbb.md', '---\npriority: 10\n---\n\nB');
    await write('ccc.md', '---\npriority: 5\n---\n\nC');
    const rules = await loadRules(tmp);
    expect(rules.map((r) => r.id)).toEqual(['bbb.md', 'aaa.md', 'ccc.md']);
  });

  it('frontmatter 完全缺省时也能加载，所有字段走默认 (tools 默认只 review)', async () => {
    await write('bare.md', '# only body\n\n纯 markdown，没 frontmatter');
    const rules = await loadRules(tmp);
    expect(rules).toHaveLength(1);
    const r = rules[0]!;
    expect(r.applies_to.project).toBeUndefined();
    expect(r.applies_to.repo).toBeUndefined();
    expect(r.tools).toEqual(['review']);
    expect(r.priority).toBe(0);
    expect(r.enabled).toBe(true);
    expect(r.instructions).toContain('# only body');
  });

  it('enabled=false 仍加载到列表 (由 match 阶段过滤)', async () => {
    await write('off.md', '---\nenabled: false\n---\n\nbody');
    const rules = await loadRules(tmp);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.enabled).toBe(false);
  });

  it('custom_labels 类型容错', async () => {
    await write(
      'labels.md',
      `---
custom_labels: [tech-debt, "needs-tests", 123, null]
---

body
`,
    );
    const rules: Rule[] = await loadRules(tmp);
    // 数字 / null 被过滤，只保留 string
    expect(rules[0]!.custom_labels).toEqual(['tech-debt', 'needs-tests']);
  });
});
