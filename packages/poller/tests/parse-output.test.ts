import { describe, expect, it } from 'vitest';
import { parseReviewOutput, sectionToFinding, splitMarkdownSections } from '../src/parse-output.js';

describe('splitMarkdownSections', () => {
  it('按 H1-H6 切片，body 去前后空白', () => {
    const md = '# Title\n\nlead body\n\n## Sub\nsub body\n';
    const out = splitMarkdownSections(md);
    expect(out.map((s) => ({ level: s.level, title: s.title }))).toEqual([
      { level: 1, title: 'Title' },
      { level: 2, title: 'Sub' },
    ]);
    expect(out[0]!.body).toBe('lead body');
    expect(out[1]!.body).toBe('sub body');
  });

  it('顶部无 header 的前导内容合成 level=0 section', () => {
    const out = splitMarkdownSections('intro line\nmore intro\n\n## Real\nbody');
    expect(out).toHaveLength(2);
    expect(out[0]!.level).toBe(0);
    expect(out[0]!.body).toBe('intro line\nmore intro');
  });

  it('\\r\\n 行尾兼容', () => {
    const out = splitMarkdownSections('# A\r\nbody\r\n## B\r\nb2\r\n');
    expect(out.map((s) => s.title)).toEqual(['A', 'B']);
  });

  it('空输入返回空数组', () => {
    expect(splitMarkdownSections('')).toEqual([]);
    expect(splitMarkdownSections('   \n  ')).toEqual([]);
  });
});

describe('sectionToFinding', () => {
  it('识别 **File:** + **Lines:** 模式 → code-feedback + anchor', () => {
    const f = sectionToFinding(
      {
        level: 3,
        title: 'Possible bug',
        body: '**File:** src/foo.ts\n**Lines:** 42-50\n**Issue:** off-by-one',
      },
      0,
      'review',
    );
    expect(f.category).toBe('code-feedback');
    expect(f.anchor).toEqual({ path: 'src/foo.ts', startLine: 42, endLine: 50 });
    expect(f.title).toBe('Possible bug');
  });

  it('单行 lines 字段也能解析 startLine', () => {
    const f = sectionToFinding(
      { level: 3, title: 't', body: '**File:** a.ts\n**Line:** 7' },
      0,
      'review',
    );
    expect(f.anchor).toEqual({ path: 'a.ts', startLine: 7 });
  });

  it('file_path / file path 变体也吃', () => {
    const f = sectionToFinding(
      { level: 3, title: 't', body: '**file_path:** x.ts\n**line_numbers:** 1-3' },
      0,
      'review',
    );
    expect(f.anchor).toEqual({ path: 'x.ts', startLine: 1, endLine: 3 });
  });

  it('反引号包裹的路径剥掉', () => {
    const f = sectionToFinding(
      { level: 3, title: 't', body: '**File:** `src/a.ts`\n**Line:** 1' },
      0,
      'review',
    );
    expect(f.anchor?.path).toBe('src/a.ts');
  });

  it('review tool 无 file 信息 → general', () => {
    const f = sectionToFinding(
      { level: 2, title: 'Estimated effort to review [1-5]', body: '3' },
      0,
      'review',
    );
    expect(f.category).toBe('general');
    expect(f.title).toBe('Estimated effort to review [1-5]');
  });

  it('describe tool 无 file → description', () => {
    const f = sectionToFinding(
      { level: 2, title: 'PR Type', body: 'feature' },
      0,
      'describe',
    );
    expect(f.category).toBe('description');
  });

  it('id 形如 <tool>-NNN', () => {
    const f = sectionToFinding({ level: 2, title: 't', body: 'x' }, 5, 'review');
    expect(f.id).toBe('review-005');
  });
});

describe('parseReviewOutput', () => {
  it('混合 sections：description + code-feedback + general 并存', () => {
    const md = [
      '## PR Review',
      '',
      '### Estimated effort to review [1-5]: 2',
      '',
      '### Possible issues',
      '- foo',
      '- bar',
      '',
      '### Code feedback',
      '**File:** src/x.ts',
      '**Lines:** 10-20',
      '**Issue:** unhandled null',
    ].join('\n');
    const { findings, summary } = parseReviewOutput(md, 'review');
    expect(summary).toBe('PR Review');
    const cats = findings.map((f) => f.category);
    expect(cats).toContain('code-feedback');
    expect(cats).toContain('general');
    const code = findings.find((f) => f.category === 'code-feedback')!;
    expect(code.anchor?.path).toBe('src/x.ts');
    expect(code.anchor?.startLine).toBe(10);
    expect(code.anchor?.endLine).toBe(20);
  });

  it('空 stdout → 空 findings 不抛', () => {
    expect(parseReviewOutput('', 'review')).toEqual({ findings: [] });
  });

  it('无 markdown header 的纯文本 → 1 个 general finding，summary 取首行', () => {
    const { findings, summary } = parseReviewOutput('plain stdout line\nmore', 'review');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.category).toBe('general');
    expect(summary).toBe('plain stdout line');
  });

  it('describe tool 全部段落落 description category', () => {
    const md = '## PR Description\nimproves foo\n\n## PR Type\nfeature';
    const { findings } = parseReviewOutput(md, 'describe');
    expect(findings.every((f) => f.category === 'description')).toBe(true);
  });
});
