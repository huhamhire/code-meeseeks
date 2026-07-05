import { describe, expect, it } from 'vitest';
import {
  parseReviewOutput,
  parseStructuredAsk,
  sectionToFinding,
  splitMarkdownSections,
  stripAnchorMarker,
} from '../src/parse-output.js';

describe('splitMarkdownSections', () => {
  it('slices by H1-H6, body trimmed of leading/trailing whitespace', () => {
    const md = '# Title\n\nlead body\n\n## Sub\nsub body\n';
    const out = splitMarkdownSections(md);
    expect(out.map((s) => ({ level: s.level, title: s.title }))).toEqual([
      { level: 1, title: 'Title' },
      { level: 2, title: 'Sub' },
    ]);
    expect(out[0]!.body).toBe('lead body');
    expect(out[1]!.body).toBe('sub body');
  });

  it('leading content with no header at the top becomes a level=0 section', () => {
    const out = splitMarkdownSections('intro line\nmore intro\n\n## Real\nbody');
    expect(out).toHaveLength(2);
    expect(out[0]!.level).toBe(0);
    expect(out[0]!.body).toBe('intro line\nmore intro');
  });

  it('\\r\\n line-ending compatibility', () => {
    const out = splitMarkdownSections('# A\r\nbody\r\n## B\r\nb2\r\n');
    expect(out.map((s) => s.title)).toEqual(['A', 'B']);
  });

  it('empty input returns an empty array', () => {
    expect(splitMarkdownSections('')).toEqual([]);
    expect(splitMarkdownSections('   \n  ')).toEqual([]);
  });
});

describe('sectionToFinding', () => {
  it('recognizes **File:** + **Lines:** pattern → code-feedback + anchor', () => {
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

  it('single-line lines field also parses startLine', () => {
    const f = sectionToFinding(
      { level: 3, title: 't', body: '**File:** a.ts\n**Line:** 7' },
      0,
      'review',
    );
    expect(f.anchor).toEqual({ path: 'a.ts', startLine: 7 });
  });

  it('file_path / file path variants also accepted', () => {
    const f = sectionToFinding(
      { level: 3, title: 't', body: '**file_path:** x.ts\n**line_numbers:** 1-3' },
      0,
      'review',
    );
    expect(f.anchor).toEqual({ path: 'x.ts', startLine: 1, endLine: 3 });
  });

  it('backtick-wrapped path stripped', () => {
    const f = sectionToFinding(
      { level: 3, title: 't', body: '**File:** `src/a.ts`\n**Line:** 1' },
      0,
      'review',
    );
    expect(f.anchor?.path).toBe('src/a.ts');
  });

  it('review tool with no file info → general', () => {
    const f = sectionToFinding(
      { level: 2, title: 'Estimated effort to review [1-5]', body: '3' },
      0,
      'review',
    );
    expect(f.category).toBe('general');
    expect(f.title).toBe('Estimated effort to review [1-5]');
  });

  it('describe tool with no file → description', () => {
    const f = sectionToFinding({ level: 2, title: 'PR Type', body: 'feature' }, 0, 'describe');
    expect(f.category).toBe('description');
  });

  it('id shaped like <tool>-NNN', () => {
    const f = sectionToFinding({ level: 2, title: 't', body: 'x' }, 5, 'review');
    expect(f.id).toBe('review-005');
  });

  it('/ask matches [file:..., lines:...] marker → promoted to code-feedback + anchor', () => {
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

  it('/ask single-line marker (no endLine) can also be promoted', () => {
    const f = sectionToFinding(
      { level: 2, title: 'Answer', body: '说明。\n[file: pkg/cache.go, lines: 17]' },
      0,
      'ask',
    );
    expect(f.category).toBe('code-feedback');
    expect(f.anchor).toEqual({ path: 'pkg/cache.go', startLine: 17 });
  });

  it('marker path containing [] still extracts anchor (path not truncated by the ] inside the path)', () => {
    const f = sectionToFinding(
      {
        level: 2,
        title: 'Answer',
        body: '租户错位风险。\n[file: 2026/11.1.x/[m-6837803244].迁移/src/context.ts, lines: 92-101]',
      },
      0,
      'ask',
    );
    expect(f.category).toBe('code-feedback');
    expect(f.anchor).toEqual({
      path: '2026/11.1.x/[m-6837803244].迁移/src/context.ts',
      startLine: 92,
      endLine: 101,
    });
  });

  it('/ask answer with no specific location (no marker) → stays general, does not force-fallback a path token', () => {
    const f = sectionToFinding(
      // intentionally contains a src/foo.ts path token, but no explicit marker and no line numbers → should stay general
      { level: 2, title: 'Answer', body: '这个 PR 整体重构了 src/foo.ts 的导出口。' },
      0,
      'ask',
    );
    expect(f.category).toBe('general');
    expect(f.anchor).toBeUndefined();
  });

  it('/describe does not promote even when content contains a marker (fallback only enabled for ask)', () => {
    const f = sectionToFinding(
      { level: 2, title: 'Description', body: 'something\n[file: a.ts, lines: 1-3]' },
      0,
      'describe',
    );
    expect(f.category).toBe('description');
  });
});

describe('stripAnchorMarker', () => {
  it('strips [file:…, lines:…] marker (including [] inside the path, not truncated by ])', () => {
    const body =
      '租户错位风险。\n[file: 2026/11.1.x/[m-6837803244].迁移/src/context.ts, lines: 92-101]';
    const out = stripAnchorMarker(body);
    expect(out).toBe('租户错位风险。');
    expect(out).not.toContain('[file:');
    expect(out).not.toContain('lines: 92-101');
  });

  it('strips a plain marker without [], and tolerates the old form without lines', () => {
    expect(stripAnchorMarker('问题。\n[file: src/a.ts, lines: 5-9]')).toBe('问题。');
    expect(stripAnchorMarker('问题。\n[file: src/a.ts]')).toBe('问题。');
  });
});

describe('parseReviewOutput', () => {
  it('mixed sections: description + code-feedback + general coexist', () => {
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

  it('empty stdout → empty findings, does not throw', () => {
    expect(parseReviewOutput('', 'review')).toEqual({ findings: [] });
  });

  it('plain text with no markdown header → 1 general finding, summary takes the first line', () => {
    const { findings, summary } = parseReviewOutput('plain stdout line\nmore', 'review');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.category).toBe('general');
    expect(summary).toBe('plain stdout line');
  });

  it('describe tool: all sections land in the description category', () => {
    const md = '## PR Description\nimproves foo\n\n## PR Type\nfeature';
    const { findings } = parseReviewOutput(md, 'describe');
    expect(findings.every((f) => f.category === 'description')).toBe(true);
  });

  // pr-agent v0.35+ LocalGitProvider /review real output: each issue renders as
  // `**header**\n\ncontent`, with no File/Lines fields (pr-agent drops the fields when rendering).
  // We split such a section into multiple independent findings, rendered as code-feedback cards on the UI side
  it('expands the "Recommended focus areas for review" section into multiple code-feedback findings', () => {
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
    expect(codeFb[0]!.anchor).toBeUndefined(); // content does not mention path → cannot extract
    expect(codeFb[1]!.title).toBe('异常处理缺失');
    // the second content mentions path + line numbers → best-effort extracted
    expect(codeFb[1]!.anchor?.path).toBe('src/foo.ts');
    expect(codeFb[1]!.anchor?.startLine).toBe(42);
    expect(codeFb[1]!.anchor?.endLine).toBe(50);
  });

  it('header with meebox:// link (injected by get_line_link) → takes structured anchor', () => {
    const md = [
      '### ⚡ Recommended focus areas for review',
      '',
      '#### ',
      '[**潜在空引用**](meebox:///src/auth/login.ts#L42-L50)',
      '',
      'tenant 可能为 null，未判空直接 getId()。', // body contains no path, still gets anchor from the link
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

  it('link has only path (model did not fill structured line numbers) → completed with line numbers from the body marker', () => {
    // real sample: get_line_link got start_line=0 → link has no #L, but the model, per our instructions,
    // wrote lines: 244-255 in the body marker. After merging, should get the complete anchor.
    const md = [
      '### ⚡ Recommended focus areas for review',
      '',
      '#### ',
      '[**潜在未定义字段**](meebox:///src/controllers/v3/SuiteTenantControllerV3.ts)',
      '',
      'doCoinBalanceGet 中 sms 可能为 undefined。',
      '[file: src/controllers/v3/SuiteTenantControllerV3.ts, lines: 244-255]',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'review');
    const c = findings.find((f) => f.category === 'code-feedback')!;
    expect(c.anchor).toEqual({
      path: 'src/controllers/v3/SuiteTenantControllerV3.ts',
      startLine: 244,
      endLine: 255,
    });
  });

  it('link path and body marker point to different files → does not borrow line numbers (avoids mismatch)', () => {
    const md = [
      '### Key Issues to Review',
      '',
      '[**X**](meebox:///src/a.ts)',
      '',
      '顺带提一句 other/b.ts 的问题 [file: other/b.ts, lines: 9-10]',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'review');
    const c = findings.find((f) => f.category === 'code-feedback')!;
    // path takes the link's a.ts; line numbers not borrowed from b.ts → only path
    expect(c.anchor).toEqual({ path: 'src/a.ts' });
  });

  it('meebox:// link URL decoding (path contains spaces)', () => {
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

  it('English "Key Issues to Review" heading also goes through the expand path', () => {
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

  it('explicit [file: ..., lines: ..] marker is a strong anchor signal', () => {
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

  it('key-issues section with no bold header → falls back to a single finding (no content lost)', () => {
    const md = [
      '### Recommended focus areas for review',
      '',
      '说明文字，model 没按 bold header 格式输出。',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'review');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.body).toMatch(/说明文字/);
  });

  it('GFM table output: <details>/<a href> finding extraction + anchor for key_issues', () => {
    const md = [
      '<table>',
      '<tr><td>⏱️&nbsp;<strong>Estimated effort to review</strong>: 3 🔵🔵🔵⚪⚪</td></tr>',
      '<tr><td>⚡&nbsp;<strong>Recommended focus areas for review</strong><br><br>',
      '',
      "<details><summary><a href='meebox:///src/auth/login.ts#L42-L50'><strong>潜在空引用</strong></a>",
      '',
      'user 可能为 null，访问 user.id 前未判空。',
      '</summary>',
      '',
      '```ts',
      '42  const id = user.id;',
      '```',
      '',
      '</details>',
      '',
      "<a href='meebox:///pkg/cache.go#L17'><strong>缓存未加锁</strong></a><br>并发写 map 可能 panic。",
      '',
      '</td></tr>',
      '</table>',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'review');
    const code = findings.filter((f) => f.category === 'code-feedback');
    expect(code.map((f) => f.title)).toEqual(['潜在空引用', '缓存未加锁']);
    expect(code[0]!.anchor).toEqual({ path: 'src/auth/login.ts', startLine: 42, endLine: 50 });
    expect(code[0]!.body).toMatch(/未判空/);
    expect(code[1]!.anchor).toEqual({ path: 'pkg/cache.go', startLine: 17 });
    // effort line also sliced into a section finding (title maps to effort)
    expect(findings.some((f) => f.sectionKey === 'effort')).toBe(true);
  });

  it('GFM key_issues cannot extract a finding → falls back to a single one (no content lost)', () => {
    const md = [
      '<table>',
      '<tr><td>⚡&nbsp;<strong>Recommended focus areas for review</strong><br><br>',
      '格式漂移，没有 a/strong 锚。',
      '</td></tr>',
      '</table>',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'review');
    expect(findings.some((f) => /格式漂移/.test(f.body))).toBe(true);
  });

  it('GFM multi-column row: preserves every <td> cell content, does not drop later columns', () => {
    const md = [
      '<table>',
      '<tr><td><strong>第一列标题</strong>: 左侧内容</td><td>右侧第二列内容 keep-me</td></tr>',
      '</table>',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'review');
    // the second cell's content must be preserved in the section body
    expect(findings.some((f) => /keep-me/.test(f.body))).toBe(true);
    expect(findings.some((f) => /左侧内容/.test(f.body))).toBe(true);
  });

  it('GFM /review: leading explanatory text before the table still goes through the HTML path, split section by section + key_issues extracts findings', () => {
    const md = [
      '以下是辅助评审的关键观察：', // a common leading sentence in real output, should not cause a misjudgment
      '',
      '<table>',
      '<tr><td>⏱️&nbsp;<strong>Estimated effort to review</strong>: 3 🔵🔵🔵⚪⚪</td></tr>',
      '<tr><td>🔒&nbsp;<strong>Security concerns</strong>: 未发现安全风险</td></tr>',
      '<tr><td>⚡&nbsp;<strong>Recommended focus areas for review</strong><br><br>',
      '',
      "<a href='meebox:///pkg/cache.go#L17'><strong>缓存未加锁</strong></a><br>并发写 map 可能 panic。",
      '',
      '</td></tr>',
      '</table>',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'review');
    // each section independent: effort / security each their own section; key_issues extracted into code-feedback findings (no longer crammed into a single summary)
    expect(findings.some((f) => f.sectionKey === 'effort')).toBe(true);
    expect(findings.some((f) => f.sectionKey === 'security')).toBe(true);
    const code = findings.filter((f) => f.category === 'code-feedback');
    expect(code.map((f) => f.title)).toContain('缓存未加锁');
    expect(code.find((f) => f.title === '缓存未加锁')!.anchor).toEqual({
      path: 'pkg/cache.go',
      startLine: 17,
    });
  });

  it('non-GFM /review: <table>/<tr> mentioned inside a code fence still goes through the markdown path (no body lost)', () => {
    const md = [
      '### PR 分析',
      '',
      '以下示例 HTML 仅作说明，并非 GFM 表格输出：',
      '',
      '```html',
      '<table><tr><td>example-cell</td></tr></table>',
      '```',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'review');
    // if misjudged into the GFM table path, splitGfmTableSections would only slice by <tr> rows and discard the markdown body.
    // going through the markdown path preserves the body (including explanatory text) intact — used to determine it did not go astray.
    expect(findings.some((f) => /仅作说明/.test(f.body))).toBe(true);
  });

  it('GFM /review: test/security sections correctly classified by conclusion-variant wording (PR contains tests / No security concerns)', () => {
    const md = [
      '<table>',
      '<tr><td>🧪&nbsp;<strong>PR contains tests</strong></td></tr>',
      '<tr><td>🔒&nbsp;<strong>No security concerns identified</strong></td></tr>',
      '</table>',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'review');
    // the old implementation only recognized "Relevant tests"/"Security concerns"; these two common conclusions would degrade to general (no chip/coloring)
    expect(findings.find((f) => /tests/i.test(f.title ?? ''))?.sectionKey).toBe('relevant-tests');
    expect(findings.find((f) => /security/i.test(f.title ?? ''))?.sectionKey).toBe('security');
  });
});

describe('parseReviewOutput · describe diagram / file walkthrough', () => {
  const md = [
    '### **PR Type**',
    'Enhancement',
    '',
    '### **Description**',
    '- 增加缓存合并',
    '',
    '### Diagram Walkthrough',
    '',
    '```mermaid',
    'flowchart LR',
    '  A["缓存未命中"] --> B["合并请求"]',
    '```',
    '',
    '<details> <summary><h3> File Walkthrough</h3></summary>',
    '',
    '<table><thead><tr><th></th><th align="left">Relevant files</th></tr></thead><tbody>',
    '<tr><td><strong>功能增强</strong></td><td><details><summary>2 files</summary><table>',
    '<tr><td><strong>CacheValueProvider.ts</strong><dd><code>增加缓存合并配置透传</code>&nbsp;</dd></td><td><a href="meebox:///packages/core/src/cache/CacheValueProvider.ts#L-1">+-1/--1</a>&nbsp;</td></tr>',
    '<tr><td><strong>SingleFlight.ts</strong><dd><code>新增进程内请求合并器</code>&nbsp;</dd></td><td><a href="meebox:///packages/core/src/cache/SingleFlight.ts#L-1">+-1/--1</a>&nbsp;</td></tr>',
    '</table></details></td></tr>',
    '<tr><td><strong>测试</strong></td><td><details><summary>1 files</summary><table>',
    '<tr><td><strong>SingleFlight.test.ts</strong><dd><code>覆盖请求合并核心逻辑</code>&nbsp;</dd></td><td><a href="meebox:///packages/core/tests/cache/SingleFlight.test.ts#L-1">+-1/--1</a>&nbsp;</td></tr>',
    '</table></details></td></tr>',
    '</tbody></table>',
    '',
    '</details>',
    '',
    '___',
  ].join('\n');

  it('Diagram Walkthrough → diagram section, body contains mermaid, no walkthrough table', () => {
    const { findings } = parseReviewOutput(md, 'describe');
    const diagram = findings.find((f) => f.sectionKey === 'diagram');
    expect(diagram).toBeDefined();
    expect(diagram!.body).toMatch(/```mermaid/);
    expect(diagram!.body).toMatch(/flowchart LR/);
    // the walkthrough block has been extracted, should not stick in the diagram body
    expect(diagram!.body).not.toMatch(/File Walkthrough|<table/);
  });

  it('File Walkthrough → walkthrough section, preserves multi-level category collapsible list, removes +1/-1', () => {
    const { findings } = parseReviewOutput(md, 'describe');
    const wt = findings.find((f) => f.sectionKey === 'walkthrough');
    expect(wt).toBeDefined();
    // each category becomes its own collapsible <details>, with a pure HTML unordered list + description inside
    expect(wt!.body).toMatch(/<details open><summary>功能增强（2）<\/summary>/);
    expect(wt!.body).toMatch(
      /<li><strong>CacheValueProvider\.ts<\/strong> — 增加缓存合并配置透传<\/li>/,
    );
    expect(wt!.body).toMatch(/<details open><summary>测试（1）<\/summary>/);
    // does not preserve the original table / +1/-1 stats
    expect(wt!.body).not.toMatch(/\+-1|\/--1|Relevant files/);
  });

  it('File Walkthrough non-collapsible form (small PR, <td><table> without <details>) still recognizes categories', () => {
    // pr-agent does not wrap categories in <details> when the file count is below the threshold; the category cell is directly <td><table>.
    const small = [
      '### Diagram Walkthrough',
      '',
      '<details> <summary><h3> File Walkthrough</h3></summary>',
      '',
      '<table><thead><tr><th></th><th align="left">Relevant files</th></tr></thead><tbody>',
      '<tr><td><strong>功能增强</strong></td><td><table>',
      '<tr><td><strong>Message.ts</strong><dd><code>新增飞书 Markdown 长度限制常量</code>&nbsp;</dd></td><td><a href="meebox:///src/Message.ts#L-1">+-1/--1</a></td></tr>',
      '</table></td></tr>',
      '<tr><td><strong>测试</strong></td><td><table>',
      '<tr><td><strong>Message.spec.ts</strong><dd><code>补充子产品未读状态测试</code>&nbsp;</dd></td><td><a href="meebox:///src/Message.spec.ts#L-1">+-1/--1</a></td></tr>',
      '</table></td></tr>',
      '</tbody></table>',
      '',
      '</details>',
    ].join('\n');
    const { findings } = parseReviewOutput(small, 'describe');
    const wt = findings.find((f) => f.sectionKey === 'walkthrough');
    expect(wt).toBeDefined();
    expect(wt!.body).toMatch(/<details open><summary>功能增强（1）<\/summary>/);
    expect(wt!.body).toMatch(/<details open><summary>测试（1）<\/summary>/);
    expect(wt!.body).toMatch(
      /<li><strong>Message\.ts<\/strong> — 新增飞书 Markdown 长度限制常量<\/li>/,
    );
    // should not degrade into a flat list with no categories
    expect(wt!.body).toContain('<details open>');
  });
});

describe('parseStructuredAsk', () => {
  it('matches three tags → three-section finding (ask-summary/analysis/suggestions), fixed order, summary into field', () => {
    const md = [
      '<summary>',
      'It is safe to merge.',
      '</summary>',
      '',
      '<analysis>',
      'Walked through the call sites; nothing reads the removed field.',
      '</analysis>',
      '',
      '<suggestions>',
      'Add a regression test for the empty-input path.',
      '</suggestions>',
    ].join('\n');
    const { findings, summary } = parseReviewOutput(md, 'ask');
    expect(findings.map((f) => f.sectionKey)).toEqual([
      'ask-summary',
      'ask-analysis',
      'ask-suggestions',
    ]);
    expect(summary).toBe('It is safe to merge.');
    expect(findings[0]!.body).toBe('It is safe to merge.');
  });

  it('only a summary section → single finding, analysis/suggestions omitted', () => {
    const md = '<summary>\nLooks good.\n</summary>';
    const { findings } = parseReviewOutput(md, 'ask');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.sectionKey).toBe('ask-summary');
  });

  it('suggestions section with line-number marker → promoted to a locatable code-suggestion (anchor extracted, marker stripped)', () => {
    const md = [
      '<suggestions>',
      'Guard the null case here.',
      '[file: src/a.ts, lines: 10-12]',
      '</suggestions>',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'ask');
    expect(findings[0]!.sectionKey).toBe('code-suggestion');
    expect(findings[0]!.body).toBe('Guard the null case here.');
    expect(findings[0]!.body).not.toContain('[file:');
    expect(findings[0]!.anchor).toEqual({ path: 'src/a.ts', startLine: 10, endLine: 12 });
  });

  it('suggestions section with multiple markers → split into code-suggestions one by one; marker-less tail merged into ask-suggestions', () => {
    const md = [
      '<suggestions>',
      '- Add a null guard.',
      '[file: src/a.ts, lines: 10]',
      '- Rename for clarity.',
      '[file: src/b.ts, lines: 20-22]',
      '- Consider documenting the overall flow.',
      '</suggestions>',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'ask');
    expect(findings.map((f) => f.sectionKey)).toEqual([
      'code-suggestion',
      'code-suggestion',
      'ask-suggestions',
    ]);
    expect(findings[0]!.anchor).toEqual({ path: 'src/a.ts', startLine: 10 });
    expect(findings[1]!.anchor).toEqual({ path: 'src/b.ts', startLine: 20, endLine: 22 });
    expect(findings[2]!.anchor).toBeUndefined();
  });

  it('suggestions section with no marker → the whole section as one ask-suggestions (same as old behavior)', () => {
    const md = ['<suggestions>', 'General advice with no specific code location.', '</suggestions>'].join(
      '\n',
    );
    const { findings } = parseReviewOutput(md, 'ask');
    expect(findings[0]!.sectionKey).toBe('ask-suggestions');
    expect(findings[0]!.body).toBe('General advice with no specific code location.');
  });

  it('no tags → falls back to plain /ask parsing (produces no ask-* sections)', () => {
    const md = 'Just a plain free-form answer with no tags.';
    expect(parseStructuredAsk(md)).toBeNull();
    const { findings } = parseReviewOutput(md, 'ask');
    expect(findings.every((f) => !String(f.sectionKey).startsWith('ask-'))).toBe(true);
  });

  it('tags present but content all empty → fallback (returns null)', () => {
    expect(parseStructuredAsk('<summary>\n\n</summary>')).toBeNull();
  });

  it('re-review <verdict> extraction (replace / keep / drop)', () => {
    const mk = (v: string): string => `<summary>x</summary>\n<verdict>${v}</verdict>`;
    expect(parseReviewOutput(mk('replace'), 'ask').askVerdict).toBe('replace');
    expect(parseReviewOutput(mk('Keep'), 'ask').askVerdict).toBe('keep');
    expect(parseReviewOutput(mk('drop'), 'ask').askVerdict).toBe('drop');
  });

  it('unknown verdict / no verdict → askVerdict undefined', () => {
    expect(
      parseReviewOutput('<summary>x</summary>\n<verdict>maybe</verdict>', 'ask').askVerdict,
    ).toBeUndefined();
    expect(parseReviewOutput('<summary>x</summary>', 'ask').askVerdict).toBeUndefined();
  });
});
