import type { CSSProperties } from 'react';
import type { TFunction } from 'i18next';
import type { Finding, PrDocSectionKey } from '@meebox/shared';

/**
 * pr-agent /review 输出的 issue body 尾部含 `[file: <path>, lines: <s>-<e>]`
 * marker — 是我们注入的 prompt directive 让 parser 抽 anchor 的，对用户无意义。
 * FindingCard 渲染前 / 转 draft 时统一清洗
 */
export function stripFindingMarker(body: string): string {
  // 路径可能含 `[]`：带 lines 时用惰性 `.+?` + 必现 `, lines:` 后缀界定（`.` 匹配 `]`，不被
  // 路径里的 `]` 误截）；无 lines 时回退到不含 `]` 的旧式。末尾锚定，只清尾部 marker。
  return body
    .replace(
      /\s*\[\s*file\s*:\s*(?:.+?\s*,\s*lines?\s*:\s*\d+(?:\s*[-–—]\s*\d+)?|[^\]\n]*?)\s*\]\s*$/i,
      '',
    )
    .trimEnd();
}

/**
 * 把 pr-agent GFM 输出里的内联 HTML 标签归一成 markdown。finding 卡片走 ReactMarkdown
 * (允许 HTML) 能正常渲染这些标签，但转成草稿正文落进编辑器 textarea / 发布到远端后，
 * 裸 `<code>` `<br>` 不一定被渲染，会暴露成字面标签。这里把常见内联标签转成等价
 * markdown：`<code>x</code>`→`` `x` ``、`<br>`→换行、`<b>/<strong>`→`**`、`<i>/<em>`→`*`。
 * 空 `<code></code>` 直接丢弃，避免产出孤立的空反引号。
 */
export function htmlInlineToMarkdown(text: string): string {
  return text
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*code\s*>([\s\S]*?)<\s*\/\s*code\s*>/gi, (_, inner: string) =>
      inner.trim() ? `\`${inner}\`` : '',
    )
    .replace(/<\s*(?:strong|b)\s*>([\s\S]*?)<\s*\/\s*(?:strong|b)\s*>/gi, '**$1**')
    .replace(/<\s*(?:em|i)\s*>([\s\S]*?)<\s*\/\s*(?:em|i)\s*>/gi, '*$1*');
}

/**
 * sectionKey → 中文标签 + 渲染顺序。把 pr-agent 输出按已知段落排成标准文档骨架：
 *   建议标题 → 类型 → 总结 → 描述 → 走查 → 测试 → 安全 → 代码反馈 → 工作量 → 评分 → 其他
 * 未识别 (sectionKey === undefined 或 'general') 走兜底，按解析顺序放到末尾。
 */
const SECTION_ORDER: Record<PrDocSectionKey, number> = {
  title: 0,
  'pr-type': 1,
  summary: 2,
  description: 3,
  diagram: 4,
  assessment: 5, // 思路建议紧随架构图（对齐 Qodo：Description → Diagram → Assessment）
  walkthrough: 6,
  'relevant-tests': 7,
  security: 8,
  'code-feedback': 9,
  'code-suggestion': 9, // 跟 code-feedback 一组，UI 顺序无优先关系
  effort: 10,
  score: 11,
  general: 12,
  // /ask 结构化分段（仅出现在 /ask run 内，彼此相对顺序：概述 → 分析 → 建议）
  'ask-summary': 13,
  'ask-analysis': 14,
  'ask-suggestions': 15,
};
const SECTION_LABEL_KEY: Record<PrDocSectionKey, string | null> = {
  title: 'chatPane.sectionTitle',
  'pr-type': 'chatPane.sectionPrType',
  summary: 'chatPane.sectionSummary',
  description: 'chatPane.sectionDescription',
  diagram: 'chatPane.sectionDiagram',
  assessment: 'chatPane.sectionAssessment',
  walkthrough: 'chatPane.sectionWalkthrough',
  'relevant-tests': 'chatPane.sectionRelevantTests',
  security: 'chatPane.sectionSecurity',
  'code-feedback': 'chatPane.sectionCodeFeedback',
  'code-suggestion': 'chatPane.sectionCodeSuggestion',
  effort: 'chatPane.sectionEffort',
  score: 'chatPane.sectionScore',
  general: null, // general / 未知段无 chip 标签
  'ask-summary': 'chatPane.sectionAskSummary',
  'ask-analysis': 'chatPane.sectionAskAnalysis',
  'ask-suggestions': 'chatPane.sectionAskSuggestions',
};
export function sectionLabel(key: PrDocSectionKey, t: TFunction): string {
  const k = SECTION_LABEL_KEY[key];
  return k ? t(k) : '';
}

/**
 * 工作量段已用 emoji 圆点（🔵🔵🔵⚪⚪）直观表示 1-5 分，去掉前面冗余的数字分数：
 *   "3 🔵🔵🔵⚪⚪" → "🔵🔵🔵⚪⚪"；"工作量: 3 🔵🔵" → "工作量: 🔵🔵"
 * 仅在数字后紧跟圆点 emoji 时才剥，避免误删正文里的普通数字。
 */
export function stripEffortScoreNumber(s: string): string {
  return s.replace(/(^|[:：]\s*)\d+\s*(?=[🔵⚪⚫🟢🔴🟠🟡🟣🟤])/u, '$1');
}

/**
 * Stable sort by sectionKey 排序 + 同 key 保留原顺序 (兼容 Array.sort 非 stable JS 引擎)。
 * effort（评估工作量）段直接过滤掉：「Estimated effort to review」实用价值低，不展示。
 */
export function orderFindings(findings: Finding[]): Finding[] {
  return findings
    .filter((f) => f.sectionKey !== 'effort')
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const ka = SECTION_ORDER[a.f.sectionKey ?? 'general'] ?? 99;
      const kb = SECTION_ORDER[b.f.sectionKey ?? 'general'] ?? 99;
      return ka === kb ? a.i - b.i : ka - kb;
    })
    .map((x) => x.f);
}

/** 锚点短标签 `<basename>:<startLine>`（复评徽标 / 引用 chip 用），无锚点返回空串。 */
export function anchorShortLabel(anchor?: {
  path: string;
  startLine?: number;
  endLine?: number;
}): string {
  if (!anchor) return '';
  const base = anchor.path.split('/').pop() ?? anchor.path;
  return anchor.startLine ? `${base}:${String(anchor.startLine)}` : base;
}

/**
 * 把一条待复评的 finding 拼成 /ask 的隐式引用上下文（referencedContext）：让模型看到原评论正文 + 位置，
 * 据此复评。与 diff 选区引用（formatReferencedContext）同走 EXTRA_INSTRUCTIONS 注入，不进问题位置参数。
 */
export function formatFindingReference(finding: Finding): string {
  const a = finding.anchor;
  const loc = a
    ? ` on \`${a.path}\`${
        a.startLine
          ? ` (L${String(a.startLine)}${
              a.endLine && a.endLine !== a.startLine ? `-L${String(a.endLine)}` : ''
            })`
          : ''
      }`
    : '';
  return `An existing review comment${loc} is being re-evaluated:\n\n${stripFindingMarker(finding.body)}`;
}

/**
 * 字符串 → HSL 色相。djb2 简化版，稳定 → 同一标签每次都同色。用于 PR Type 胶囊
 * 自动配色（"Bug fix" / "Enhancement" / "Tests" 各拿不同的色，不需要硬编码字典）。
 */
function labelHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
export function pillStyle(s: string): CSSProperties {
  // 仅注入标签 hue（--pill-hue）；明暗两套的饱和 / 明度由 CSS 按主题定（见 .pr-type-pill）——
  // 避免在 JS 里写死暗色 HSL（底色 L=22%）导致浅色主题下胶囊过深、不协调。
  return { ['--pill-hue']: labelHue(s) } as CSSProperties;
}
/**
 * 把 "Bug fix, Enhancement\nTests" 拆成 ["Bug fix", "Enhancement", "Tests"]。
 * parser 层已经剥过 HR，这里再加一层防御：纯标点 / 长度 ≤1 的项直接 filter 掉，
 * 避免 markdown 装饰符号溜进胶囊（"---" 这种实际遇到过）
 */
export function splitTypeLabels(body: string): string[] {
  return body
    .split(/[,\n]/)
    .map((s) => s.replace(/^[\s\-*_·•]+|[\s\-*_·•.]+$/g, '').trim())
    .filter((s) => s.length > 1 && !/^[\s\-*_·•.]+$/.test(s));
}
