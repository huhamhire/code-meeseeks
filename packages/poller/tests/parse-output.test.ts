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

  it('/ask 命中 [file:..., lines:...] marker → 升格 code-feedback + anchor', () => {
    const f = sectionToFinding(
      {
        level: 2,
        title: 'Answer',
        body: '这里有空引用风险。\n[file: src/auth/login.ts, lines: 42-50]',
      },
      0,
      'ask',
    );
    expect(f.category).toBe('code-feedback');
    expect(f.anchor).toEqual({ path: 'src/auth/login.ts', startLine: 42, endLine: 50 });
  });

  it('/ask 单行 marker (无 endLine) 也能升格', () => {
    const f = sectionToFinding(
      { level: 2, title: 'Answer', body: '说明。\n[file: pkg/cache.go, lines: 17]' },
      0,
      'ask',
    );
    expect(f.category).toBe('code-feedback');
    expect(f.anchor).toEqual({ path: 'pkg/cache.go', startLine: 17 });
  });

  it('/ask 答案不涉及具体位置 (无 marker) → 留 general，不强行兜底路径 token', () => {
    const f = sectionToFinding(
      // 故意含 src/foo.ts 路径 token，但没显式 marker 也没行号 → 应保持 general
      { level: 2, title: 'Answer', body: '这个 PR 整体重构了 src/foo.ts 的导出口。' },
      0,
      'ask',
    );
    expect(f.category).toBe('general');
    expect(f.anchor).toBeUndefined();
  });

  it('/describe 即使内容含 marker 也不升格 (兜底仅 ask 启用)', () => {
    const f = sectionToFinding(
      { level: 2, title: 'Description', body: 'something\n[file: a.ts, lines: 1-3]' },
      0,
      'describe',
    );
    expect(f.category).toBe('description');
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

  // pr-agent v0.35+ LocalGitProvider /review 真实输出：每条 issue 渲染成
  // `**header**\n\ncontent`，没有 File/Lines 字段（pr-agent 渲染时丢字段）。
  // 我们要把这种段拆成多条独立 finding，UI 端按 code-feedback 卡片渲染
  it('展开 "Recommended focus areas for review" 段为多条 code-feedback finding', () => {
    const md = [
      '## PR Reviewer Guide',
      '',
      '### ⚡ Recommended focus areas for review',
      '',
      '#### ',
      '**潜在空引用**',
      '',
      'goTenantLoginView 方法中通过 getTenantById 获取租户后直接调用 getId()，',
      '但未判断 tenant 是否为 null/undefined。',
      '',
      '#### ',
      '**异常处理缺失**',
      '',
      '在 src/foo.ts 文件第 42-50 行，try-catch 没有捕获 NetworkError。',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'review');
    const codeFb = findings.filter((f) => f.category === 'code-feedback');
    expect(codeFb).toHaveLength(2);
    expect(codeFb[0]!.title).toBe('潜在空引用');
    expect(codeFb[0]!.body).toMatch(/goTenantLoginView/);
    expect(codeFb[0]!.anchor).toBeUndefined(); // 内容没提到 path → 抽不到
    expect(codeFb[1]!.title).toBe('异常处理缺失');
    // 第二条 content 里提到了路径 + 行号 → best-effort 抽到
    expect(codeFb[1]!.anchor?.path).toBe('src/foo.ts');
    expect(codeFb[1]!.anchor?.startLine).toBe(42);
    expect(codeFb[1]!.anchor?.endLine).toBe(50);
  });

  it('header 带 meebox:// 链接（get_line_link 注入）→ 取结构化 anchor', () => {
    const md = [
      '### ⚡ Recommended focus areas for review',
      '',
      '#### ',
      '[**潜在空引用**](meebox:///src/auth/login.ts#L42-L50)',
      '',
      'tenant 可能为 null，未判空直接 getId()。', // 正文不含 path，仍能从链接拿 anchor
      '',
      '#### ',
      '[**单行定位**](meebox:///pkg/cache.go#L17)',
      '',
      '缓存键复用。',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'review');
    const code = findings.filter((f) => f.category === 'code-feedback');
    expect(code).toHaveLength(2);
    expect(code[0]!.title).toBe('潜在空引用');
    expect(code[0]!.anchor).toEqual({ path: 'src/auth/login.ts', startLine: 42, endLine: 50 });
    expect(code[1]!.title).toBe('单行定位');
    expect(code[1]!.anchor).toEqual({ path: 'pkg/cache.go', startLine: 17 });
  });

  it('meebox:// 链接 URL 解码（路径含空格）', () => {
    const md = [
      '### Key Issues to Review',
      '',
      '[**命名空间**](meebox:///src/my%20dir/a.ts#L3-L4)',
      '',
      '内容。',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'review');
    const c = findings.find((f) => f.category === 'code-feedback')!;
    expect(c.anchor).toEqual({ path: 'src/my dir/a.ts', startLine: 3, endLine: 4 });
  });

  it('英文 "Key Issues to Review" 标题也走展开路径', () => {
    const md = [
      '### 🔍 Key Issues to Review',
      '',
      '**Off-by-one**',
      '',
      'In utils/parse.ts at line 17, the slice index is one too high.',
      '',
      '**Missing null check**',
      '',
      'The handler does not check req.user.',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'review');
    const code = findings.filter((f) => f.category === 'code-feedback');
    expect(code.map((f) => f.title)).toEqual(['Off-by-one', 'Missing null check']);
    expect(code[0]!.anchor?.path).toBe('utils/parse.ts');
    expect(code[0]!.anchor?.startLine).toBe(17);
  });

  it('显式 [file: ..., lines: ..] marker 是 anchor 强信号', () => {
    const md = [
      '### Recommended focus areas for review',
      '',
      '**Stale cache**',
      '',
      'Cache key is reused across sessions.',
      '[file: src/cache.ts, lines: 88-93]',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'review');
    const c = findings.find((f) => f.category === 'code-feedback')!;
    expect(c.anchor).toEqual({ path: 'src/cache.ts', startLine: 88, endLine: 93 });
  });

  it('key-issues 段无 bold header → 退回单 finding（不丢内容）', () => {
    const md = [
      '### Recommended focus areas for review',
      '',
      '说明文字，model 没按 bold header 格式输出。',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'review');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.body).toMatch(/说明文字/);
  });
});
