import { describe, expect, it } from 'vitest';
import {
  parseReviewOutput,
  parseStructuredAsk,
  sectionToFinding,
  splitMarkdownSections,
  stripAnchorMarker,
} from '../src/parse-output.js';

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
    const f = sectionToFinding({ level: 2, title: 'PR Type', body: 'feature' }, 0, 'describe');
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

  it('marker 路径含 [] 仍能抽出 anchor（path 不被路径里的 ] 误截）', () => {
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

describe('stripAnchorMarker', () => {
  it('清掉 [file:…, lines:…] marker（含路径里的 []，不被 ] 误截）', () => {
    const body =
      '租户错位风险。\n[file: 2026/11.1.x/[m-6837803244].迁移/src/context.ts, lines: 92-101]';
    const out = stripAnchorMarker(body);
    expect(out).toBe('租户错位风险。');
    expect(out).not.toContain('[file:');
    expect(out).not.toContain('lines: 92-101');
  });

  it('清掉无 [] 的普通 marker，并兼容无 lines 的旧式', () => {
    expect(stripAnchorMarker('问题。\n[file: src/a.ts, lines: 5-9]')).toBe('问题。');
    expect(stripAnchorMarker('问题。\n[file: src/a.ts]')).toBe('问题。');
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

  it('链接只有 path（模型没填结构化行号）→ 用正文 marker 的行号补全', () => {
    // 真实样本：get_line_link 拿到 start_line=0 → 链接无 #L，但模型按我们的指令
    // 在正文 marker 里写了 lines: 244-255。合并后应拿到完整 anchor。
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

  it('链接 path 与正文 marker 指向不同文件 → 不借行号（避免错配）', () => {
    const md = [
      '### Key Issues to Review',
      '',
      '[**X**](meebox:///src/a.ts)',
      '',
      '顺带提一句 other/b.ts 的问题 [file: other/b.ts, lines: 9-10]',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'review');
    const c = findings.find((f) => f.category === 'code-feedback')!;
    // path 取链接的 a.ts；行号不借 b.ts 的 → 只有 path
    expect(c.anchor).toEqual({ path: 'src/a.ts' });
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

  it('GFM 表格输出：key_issues 的 <details>/<a href> finding 抽取 + anchor', () => {
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
    // effort 行也切成 section finding（标题映射到 effort）
    expect(findings.some((f) => f.sectionKey === 'effort')).toBe(true);
  });

  it('GFM key_issues 抽不到 finding → 退回单条（不丢内容）', () => {
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

  it('GFM 多列行：保留每个 <td> 单元格内容，不丢后续列', () => {
    const md = [
      '<table>',
      '<tr><td><strong>第一列标题</strong>: 左侧内容</td><td>右侧第二列内容 keep-me</td></tr>',
      '</table>',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'review');
    // 第二个单元格的内容必须保留在 section body 里
    expect(findings.some((f) => /keep-me/.test(f.body))).toBe(true);
    expect(findings.some((f) => /左侧内容/.test(f.body))).toBe(true);
  });

  it('GFM /review：表格前有前导说明文字仍走 HTML 路径，逐段拆分 + key_issues 抽 finding', () => {
    const md = [
      '以下是辅助评审的关键观察：', // 真实输出常见的前导句，不应导致漏判
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
    // 逐段独立：工作量 / 安全 各自成段；key_issues 抽成 code-feedback finding（不再挤进单条总结）
    expect(findings.some((f) => f.sectionKey === 'effort')).toBe(true);
    expect(findings.some((f) => f.sectionKey === 'security')).toBe(true);
    const code = findings.filter((f) => f.category === 'code-feedback');
    expect(code.map((f) => f.title)).toContain('缓存未加锁');
    expect(code.find((f) => f.title === '缓存未加锁')!.anchor).toEqual({
      path: 'pkg/cache.go',
      startLine: 17,
    });
  });

  it('非 GFM /review：代码围栏里提到 <table>/<tr> 仍走 markdown 路径（不丢正文）', () => {
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
    // 若误判进 GFM 表格路径，splitGfmTableSections 只会按 <tr> 行切片、丢弃 markdown 正文。
    // 走 markdown 路径则正文（含说明文字）完整保留 —— 以此判定未走偏。
    expect(findings.some((f) => /仅作说明/.test(f.body))).toBe(true);
  });

  it('GFM /review：测试/安全段按结论变体文案（PR contains tests / No security concerns）正确归类', () => {
    const md = [
      '<table>',
      '<tr><td>🧪&nbsp;<strong>PR contains tests</strong></td></tr>',
      '<tr><td>🔒&nbsp;<strong>No security concerns identified</strong></td></tr>',
      '</table>',
    ].join('\n');
    const { findings } = parseReviewOutput(md, 'review');
    // 旧实现只认 "Relevant tests"/"Security concerns"，这两种常见结论会退化成 general（无 chip/配色）
    expect(findings.find((f) => /tests/i.test(f.title ?? ''))?.sectionKey).toBe('relevant-tests');
    expect(findings.find((f) => /security/i.test(f.title ?? ''))?.sectionKey).toBe('security');
  });
});

describe('parseReviewOutput · describe 架构图 / 文件走查', () => {
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

  it('Diagram Walkthrough → diagram 段，body 含 mermaid，不含走查表格', () => {
    const { findings } = parseReviewOutput(md, 'describe');
    const diagram = findings.find((f) => f.sectionKey === 'diagram');
    expect(diagram).toBeDefined();
    expect(diagram!.body).toMatch(/```mermaid/);
    expect(diagram!.body).toMatch(/flowchart LR/);
    // 走查块已被抽走，不应黏在 diagram body 里
    expect(diagram!.body).not.toMatch(/File Walkthrough|<table/);
  });

  it('File Walkthrough → walkthrough 段，保留多级分类折叠列表，去掉 +1/-1', () => {
    const { findings } = parseReviewOutput(md, 'describe');
    const wt = findings.find((f) => f.sectionKey === 'walkthrough');
    expect(wt).toBeDefined();
    // 每个分类各自独立成可折叠 <details>，内部纯 HTML 无序列表 + 描述
    expect(wt!.body).toMatch(/<details open><summary>功能增强（2）<\/summary>/);
    expect(wt!.body).toMatch(
      /<li><strong>CacheValueProvider\.ts<\/strong> — 增加缓存合并配置透传<\/li>/,
    );
    expect(wt!.body).toMatch(/<details open><summary>测试（1）<\/summary>/);
    // 不保留原始表格 / +1/-1 统计
    expect(wt!.body).not.toMatch(/\+-1|\/--1|Relevant files/);
  });

  it('File Walkthrough 非折叠形态（小 PR，<td><table> 无 <details>）仍识别出分类', () => {
    // pr-agent 在文件数低于阈值时不给分类包 <details>，分类单元格直接是 <td><table>。
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
    // 不应退化成无分类的平铺列表
    expect(wt!.body).toContain('<details open>');
  });
});

describe('parseStructuredAsk', () => {
  it('命中三标签 → 三段 finding（ask-summary/analysis/suggestions），顺序固定、summary 入字段', () => {
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

  it('只有 summary 段 → 单 finding，analysis/suggestions 省略', () => {
    const md = '<summary>\nLooks good.\n</summary>';
    const { findings } = parseReviewOutput(md, 'ask');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.sectionKey).toBe('ask-summary');
  });

  it('suggestions 段带行号 marker → 升为可定位 code-suggestion（anchor 提取、marker 剥除）', () => {
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

  it('suggestions 段多条 marker → 逐条拆成 code-suggestion；无 marker 尾部归并为 ask-suggestions', () => {
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

  it('suggestions 段无 marker → 整段一条 ask-suggestions（同旧行为）', () => {
    const md = ['<suggestions>', 'General advice with no specific code location.', '</suggestions>'].join(
      '\n',
    );
    const { findings } = parseReviewOutput(md, 'ask');
    expect(findings[0]!.sectionKey).toBe('ask-suggestions');
    expect(findings[0]!.body).toBe('General advice with no specific code location.');
  });

  it('无标签 → 回退普通 /ask 解析（不产出 ask-* 段）', () => {
    const md = 'Just a plain free-form answer with no tags.';
    expect(parseStructuredAsk(md)).toBeNull();
    const { findings } = parseReviewOutput(md, 'ask');
    expect(findings.every((f) => !String(f.sectionKey).startsWith('ask-'))).toBe(true);
  });

  it('标签存在但内容全空 → 回退（返回 null）', () => {
    expect(parseStructuredAsk('<summary>\n\n</summary>')).toBeNull();
  });

  it('复评 <verdict> 抽取（replace / keep / drop）', () => {
    const mk = (v: string): string => `<summary>x</summary>\n<verdict>${v}</verdict>`;
    expect(parseReviewOutput(mk('replace'), 'ask').askVerdict).toBe('replace');
    expect(parseReviewOutput(mk('Keep'), 'ask').askVerdict).toBe('keep');
    expect(parseReviewOutput(mk('drop'), 'ask').askVerdict).toBe('drop');
  });

  it('未知 verdict / 无 verdict → askVerdict undefined', () => {
    expect(
      parseReviewOutput('<summary>x</summary>\n<verdict>maybe</verdict>', 'ask').askVerdict,
    ).toBeUndefined();
    expect(parseReviewOutput('<summary>x</summary>', 'ask').askVerdict).toBeUndefined();
  });
});
