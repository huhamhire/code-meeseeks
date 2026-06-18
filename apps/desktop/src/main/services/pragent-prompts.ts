import type { ReviewRunTool } from '@meebox/shared';

/**
 * pr-agent 提示词组装：把注入各 tool 的 EXTRA_INSTRUCTIONS、/ask 语言后缀、以及输出回显去重
 * 收口到本模块，避免散落在 run 队列执行逻辑里。纯字符串构造，不含 I/O / 运行时依赖。
 */

/**
 * 把 config.language (ISO locale) 翻成自然语言 prompt directive。
 *
 * CONFIG__RESPONSE_LANGUAGE 对 /describe /review 已经够用 (内嵌在它们的 prompt template)，但
 * /ask 不严格遵守；显式 prompt 强化所有 tool，尤其覆盖 /ask + 表格类输出的标题 / 列名 / 段落标记。
 * 英文 (en-US) 返回空串，避免给 LLM 加不必要的提示。其他未知 locale 返回空保留 pr-agent 原行为。
 */
function languageDirectiveFor(lang: string): string {
  const norm = lang.toLowerCase();
  if (norm.startsWith('zh-cn') || norm === 'zh') {
    return 'Respond in Simplified Chinese (简体中文). All section labels, table headers, column names, headings, and content MUST be in Chinese — do not leave any English template strings untranslated.';
  }
  if (norm.startsWith('zh-tw') || norm.startsWith('zh-hk')) {
    return 'Respond in Traditional Chinese (繁體中文). All section labels, table headers, column names, headings, and content MUST be in Chinese.';
  }
  if (norm.startsWith('ja')) {
    return 'Respond in Japanese (日本語). All section labels, table headers, column names, headings, and content MUST be in Japanese — do not leave any English template strings untranslated.';
  }
  if (norm.startsWith('de')) {
    return 'Respond in German (Deutsch). All section labels, table headers, column names, headings, and content MUST be in German — do not leave any English template strings untranslated.';
  }
  return '';
}

/**
 * anchor marker 指令：让 model 在涉及代码位置的内容末尾显式追加
 *   [file: <path>, lines: <start_line>-<end_line>]
 *
 * 主路径已改为 sitecustomize 注入 LocalGitProvider.get_line_link → key_issues 渲染成
 * `[**header**](meebox:///<file>#L<s>-L<e>)`，parse-output 取结构化 anchor（path 来自
 * provider 同源、最可靠）。但 #L 行号仍依赖 model 填了 pr-agent 原生 start_line/end_line YAML
 * 字段；实测部分模型只填这条 marker、留空结构化字段 → 链接只有 path。故这条 marker 作为**行号
 * 兜底**保留：parse-output 合并时链接给 path、缺行号则用 marker 的行号补（resolveIssueAnchor）。
 *
 * - /review: 每条 key_issue 末尾 **必加** marker
 * - /ask: 仅当回答涉及具体文件 / 代码位置时 **才加**（自由问答可能完全跟代码无关，强制会产假阳性）
 * - /describe / /improve 不注入：前者不出 issue，后者走 marker 行 `[file [start-end]](url)` 自带 anchor
 */
function anchorMarkerDirective(tool: ReviewRunTool): string {
  if (tool === 'review') {
    return [
      'When writing each item under `key_issues_to_review`, append on its OWN LAST LINE',
      'a machine-readable anchor marker in this EXACT format:',
      '',
      '    [file: <relevant_file>, lines: <start_line>-<end_line>]',
      '',
      'Examples:',
      '  [file: src/auth/login.ts, lines: 42-50]',
      '  [file: pkg/cache.go, lines: 17]',
      '',
      'Use the exact relevant_file path and start_line/end_line you already',
      'identified in the YAML output. Do NOT wrap the path in backticks. If you',
      'truly cannot identify a file/line for an issue, omit the marker for that',
      'item only.',
    ].join('\n');
  }
  if (tool === 'ask') {
    return [
      'CRITICAL: This answer is consumed by a code review GUI that converts your',
      'per-paragraph recommendations into INLINE COMMENTS pinned to specific code',
      'lines. For that to work, EVERY paragraph that names a code symbol (function,',
      'method, class, variable, identifier) from this PR MUST end with a',
      'machine-readable anchor marker on its OWN LAST LINE:',
      '',
      '    [file: <path>, lines: <start_line>-<end_line>]',
      '',
      'Examples:',
      '  [file: src/auth/login.ts, lines: 42-50]',
      '  [file: pkg/cache.go, lines: 17]',
      '  [file: pkg/store.ts]              (path-only fallback; only when you',
      '                                     truly cannot infer any line number)',
      '',
      'How to derive line numbers from the diff:',
      '- Every hunk in the diff begins with a header:',
      '    @@ -<base_start>,<base_count> +<head_start>,<head_count> @@',
      '  The number after `+` is the FIRST head-side line of that hunk. Count down',
      '  through `+` (added) and ` ` (context) lines — DO NOT count `-` (removed)',
      '  lines — to locate the line where the symbol appears. Prefer head-side',
      '  line numbers. For code that ONLY exists on the base side (purely removed),',
      '  use the base-side `-` line number instead.',
      '',
      'Rules — read carefully:',
      '- The marker is REQUIRED. Do not skip it when your paragraph references a',
      '  real code symbol from the diff. A paragraph without a marker becomes',
      '  un-pinnable feedback the user cannot turn into a comment.',
      '- Append exactly ONE marker per paragraph, at the very end of that paragraph,',
      '  on its own line (blank line above it optional but recommended).',
      '- If a paragraph discusses multiple locations, pick the most important one',
      '  (the line where the recommended change should be made).',
      '- Paragraphs that are purely general / conceptual / meta (e.g., overall',
      '  praise, no specific symbol named) MAY omit the marker.',
      '- Use the exact file path from the diff. Do NOT wrap the path in backticks',
      '  or quotes inside the marker.',
      '- If you really cannot pin a line, fall back to path-only `[file: <path>]`',
      '  rather than omitting the marker entirely.',
    ].join('\n');
  }
  return '';
}

/**
 * 排版指令：只改 /review 每条 key_issue 的断行排版，提升 GUI 可读性，不增加篇幅。
 * pr-agent 原 prompt 要 "short and concise summary"，模型默认堆成单段长跑文；渲染层
 * (ReactMarkdown + remarkBreaks) 忠实呈现，空行分段即成独立 <p>。关键是「保持简洁」——只在
 * 现象/影响/建议的语义边界换行，不得借分段扩写内容。须与 anchor marker 协同：分段在正文内部，
 * marker 仍独占最末行。
 */
function reviewLayoutDirective(tool: ReviewRunTool): string {
  if (tool !== 'review') return '';
  return [
    'FORMATTING ONLY: Keep each `key_issues_to_review` item as concise as you',
    'already would — do NOT add length, padding, or extra explanation. The only',
    'change is line breaks: instead of one dense run-on paragraph, insert a BLANK',
    'LINE at the natural boundaries (e.g. problem → impact → suggested fix) so the',
    'text reads as a few short paragraphs. Same words, better layout.',
    '',
    'This applies to the issue PROSE only. The machine-readable anchor marker',
    'described above still goes on its OWN LAST LINE, after the final paragraph',
    '(a blank line may precede it).',
  ].join('\n');
}

/**
 * 组装注入 pr-agent 的 EXTRA_INSTRUCTIONS：按序拼接 语言指示 / anchor marker / 排版 / PR 上下文 /
 * 命中规则，空段跳过；全空返回 undefined（调用方据此决定是否设 env）。
 * - 语言指示：CONFIG__RESPONSE_LANGUAGE 对 /describe /review 够用，但 /ask 走 [pr_questions] 不严格
 *   遵守，必须显式强化
 * - PR 上下文 / 规则由调用方现读传入（local provider 不自己去远端拉这些）
 */
export function buildExtraInstructions(input: {
  tool: ReviewRunTool;
  language: string;
  prContext: string;
  matchedRuleInstructions: string;
}): string | undefined {
  const parts = [
    languageDirectiveFor(input.language),
    anchorMarkerDirective(input.tool),
    reviewLayoutDirective(input.tool),
    input.prContext,
    input.matchedRuleInstructions,
  ].filter((s) => s.trim());
  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
}

/** EXTRA_INSTRUCTIONS 对应的 pr-agent env key（按 tool）。 */
export function extraInstructionsEnvKey(tool: ReviewRunTool): string {
  switch (tool) {
    case 'describe':
      return 'PR_DESCRIPTION__EXTRA_INSTRUCTIONS';
    case 'review':
      return 'PR_REVIEWER__EXTRA_INSTRUCTIONS';
    case 'improve':
      return 'PR_CODE_SUGGESTIONS__EXTRA_INSTRUCTIONS';
    default:
      return 'PR_QUESTIONS__EXTRA_INSTRUCTIONS';
  }
}

/**
 * /ask 专用：把语言要求作为「问题末尾」的硬性指令，**用目标语言书写本身**（最能促使模型切换到该
 * 语言作答）。系统侧 CONFIG__RESPONSE_LANGUAGE / EXTRA_INSTRUCTIONS 对自由问答常被大量英文 diff
 * 盖过，故在 user turn 末尾（近因位置）再要求一次。en-US / 未知 locale 返回空串（默认即英文）。
 */
export function askLanguageSuffixFor(lang: string): string {
  const norm = lang.toLowerCase();
  if (norm.startsWith('zh-cn') || norm === 'zh') {
    return '请用简体中文回答整个回复（包括所有解释、说明与结论）。代码、标识符、文件路径保留原样，但所有叙述文字必须是简体中文，不要用英文作答。';
  }
  if (norm.startsWith('zh-tw') || norm.startsWith('zh-hk')) {
    return '請用繁體中文回答整個回覆（包括所有解釋、說明與結論）。程式碼、識別符、檔案路徑保留原樣，但所有敘述文字必須是繁體中文，不要用英文作答。';
  }
  if (norm.startsWith('ja')) {
    return '回答全体を日本語で記述してください（説明・結論を含む）。コード・識別子・ファイルパスはそのまま残し、説明文はすべて日本語にしてください。英語で回答しないでください。';
  }
  if (norm.startsWith('de')) {
    return 'Bitte antworte vollständig auf Deutsch (einschließlich aller Erklärungen und Schlussfolgerungen). Code, Bezeichner und Dateipfade bleiben unverändert, aber der gesamte erläuternde Text muss auf Deutsch sein. Antworte nicht auf Englisch.';
  }
  return '';
}

/**
 * /ask 输出去重：pr-agent answer markdown 里会回显完整问题（以及我们追加到问题末尾的语言要求），
 * 跟 UI chat-user-msg 气泡重复。逐行精确匹配（trim 后整行 == 任一给定串）删掉，保留其余正文。
 */
export function stripAskQuestionEcho(md: string, ...echoed: string[]): string {
  const qs = new Set(echoed.map((q) => q.trim()).filter(Boolean));
  if (!qs.size || !md) return md;
  return md
    .split('\n')
    .filter((line) => !qs.has(line.trim()))
    .join('\n');
}
