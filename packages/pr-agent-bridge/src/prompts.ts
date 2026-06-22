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
 * - /ask: **不注入**——/ask 走结构化分段（见 structuredAskDirective），其建议定位走「被引用 finding 的
 *   anchor」（复评取代场景），无需逐段 marker；而强制逐段 marker 会把回答压成纯文本逐段、回避表格 / 代码块，
 *   削弱 pr-agent 原生 /ask 的富文本表现（实测）。故对 /ask 取消该指令，保留 pr-agent 原生作答风格。
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
 * /ask 结构化分段指令：结构化只是**在 pr-agent 原生 /ask 富文本回答之上加一层轻包装**——把回答包进
 * 字面 `<summary>` / `<analysis>` / `<suggestions>` 三段，便于 GUI 归纳；段内内容保持 pr-agent 原生
 * 表现（表格 / 代码块 / 子标题 / 列表、深度照常），不削减。summary 必填（结论，GUI 高亮展开）、analysis
 * 可省（完整过程分析，GUI 默认收起）、suggestions 可省（可执行建议，**逐条带代码定位标记** → GUI 解析成
 * 可采纳的「代码建议」卡）。仅 /ask 注入；模型未遵循时 parse-output 整体回退普通解析（见 packages/poller）。
 */
function structuredAskDirective(tool: ReviewRunTool): string {
  if (tool !== 'ask') return '';
  return [
    'Answer the question with the SAME depth, structure, and rich GitHub-flavored Markdown',
    'you normally would — multiple paragraphs, sub-headings, bullet/numbered lists, TABLES,',
    'and fenced ```code``` blocks wherever they help. On TOP of that natural answer, wrap it',
    'in three XML-style sections (in this exact order, each tag on its own line) so a',
    'code-review GUI can present it. The tags are an ADDITIVE wrapper — they must NOT make you',
    'shorten, flatten, or strip formatting from your answer.',
    '',
    '  <summary>',
    '  The key takeaway / direct conclusion in a few sentences — what the reviewer reads first.',
    '  </summary>',
    '',
    '  <analysis>',
    '  Your full, natural answer: the complete investigation / discussion, AS DETAILED as the',
    '  question warrants, using tables / code blocks / sub-sections freely (this is exactly the',
    '  rich answer you would give without any wrapper). Collapsed by default in the GUI, so put',
    '  the depth here.',
    '  </analysis>',
    '',
    '  <suggestions>',
    '  Concrete, actionable recommendations, as a list. For EACH recommendation that targets a',
    '  specific place in the code, end that item with a machine-readable anchor marker on its',
    '  OWN line so the GUI can pin it as an inline code suggestion with line-number location:',
    '      [file: <path>, lines: <start_line>-<end_line>]',
    '  Examples:  [file: src/auth/login.ts, lines: 42-50]   [file: pkg/cache.go, lines: 17]',
    '  One marker per item, right after that item; derive the line numbers from the diff hunk',
    '  headers (the number after `+` is the first head-side line; count `+` and ` ` lines, not',
    '  `-`). Omit the marker for purely general / non-code advice. Omit this whole section if',
    '  you have no actionable suggestion.',
    '  </suggestions>',
    '',
    'Rules:',
    '- <summary> is REQUIRED. <analysis> and <suggestions> are OPTIONAL — omit the whole tag',
    '  pair when empty; never emit an empty tag.',
    '- Use the literal lowercase tags exactly as shown; do not nest them or invent other tags.',
    '  Write the content (in the requested response language) between the tags; avoid stray',
    '  prose outside the tags.',
  ].join('\n');
}

/**
 * /ask 复评模式指令：本次 /ask 是对一条既有评审评论（正文随 referencedContext 给出）的复评时注入。
 * 在结构化三段基础上，要求模型额外给出 `<verdict>` 裁决——replace（取代：给改进后的评论，写进
 * `<suggestions>`）/ keep（原评论成立）/ drop（原评论不成立、无需评论）。驱动结果卡的采纳 / 关闭动作。
 */
function referencedAskDirective(tool: ReviewRunTool, hasReferencedFinding: boolean): string {
  if (tool !== 'ask' || !hasReferencedFinding) return '';
  return [
    'RE-EVALUATION MODE: You are re-evaluating an EXISTING review comment (its text is',
    'provided in the referenced selection). Decide whether that comment should stand, be',
    'replaced, or be dropped, and end your answer with EXACTLY ONE verdict tag on its own',
    'line:',
    '',
    '  <verdict>replace</verdict>  — the original comment is wrong / weak / outdated; your',
    '    improved comment should REPLACE it. Put the proposed replacement comment text in',
    '    the <suggestions> section.',
    '  <verdict>keep</verdict>     — the original comment is valid and should stand as-is.',
    '  <verdict>drop</verdict>     — the original comment is not warranted (false positive /',
    '    non-issue); no comment is needed.',
    '',
    'Keep <summary> to your conclusion, put the reasoning in <analysis>, and (for replace)',
    'the proposed replacement comment in <suggestions>, ending it with the',
    '[file: <path>, lines: <start>-<end>] marker for the referenced code location so the',
    'replacement stays pinned to the same place as the original comment.',
  ].join('\n');
}

/**
 * 组装注入 pr-agent 的 EXTRA_INSTRUCTIONS：按序拼接 语言指示 / anchor marker / 结构化分段 / 复评裁决 /
 * 排版 / PR 上下文 / 命中规则，空段跳过；全空返回 undefined（调用方据此决定是否设 env）。
 * - 语言指示：CONFIG__RESPONSE_LANGUAGE 对 /describe /review 够用，但 /ask 走 [pr_questions] 不严格
 *   遵守，必须显式强化
 * - PR 上下文 / 规则由调用方现读传入（local provider 不自己去远端拉这些）
 */
export function buildExtraInstructions(input: {
  tool: ReviewRunTool;
  language: string;
  prContext: string;
  matchedRuleInstructions: string;
  /** 用户在 Diff 里选中的代码片段（自描述引用块，渲染层已拼好），仅 /ask 注入。 */
  referencedContext?: string;
  /** 本次 /ask 是否为对某条既有评论的「复评」；为真则注入复评裁决指示（仅 /ask）。 */
  referencedFinding?: boolean;
}): string | undefined {
  const parts = [
    languageDirectiveFor(input.language),
    anchorMarkerDirective(input.tool),
    structuredAskDirective(input.tool),
    referencedAskDirective(input.tool, !!input.referencedFinding),
    reviewLayoutDirective(input.tool),
    input.prContext,
    input.referencedContext ?? '',
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
 * /ask 输出去问题回显。pr-agent 把答案产物写成
 *   `### **Ask**❓\n<question>\n\n### **Answer:**\n<answer>`，
 * 其中 `<question>` 含我们追加到问题末尾的格式指令（结构化分段 / anchor / 复评裁决——内含字面
 * `<summary>` / `<verdict>` 等**示例标签**），若不剔除会污染下游结构化解析（parseStructuredAsk 会误把
 * 示例标签当答案）。
 *
 * 策略：优先按 pr-agent 固定的英文「Answer」表头切，只取其后的答案（连同问题回显 + 注入指令一并丢弃）；
 * 表头缺失（版本漂移）时回退到逐行精确匹配删掉回显的问题 / 语言后缀行。
 */
export function stripAskQuestionEcho(md: string, ...echoed: string[]): string {
  if (!md) return md;
  // pr_questions.py `_prepare_pr_answer` 硬编码英文 `### **Answer:**`（不随响应语言本地化）。
  const answerRe = /^#{1,6}\s*\*\*\s*Answer\s*:?\s*\*\*\s*$/im;
  const m = answerRe.exec(md);
  if (m) return md.slice(m.index + m[0].length).replace(/^\s+/, '');
  // 回退：逐行精确匹配（trim 后整行 == 任一给定串）删掉，保留其余正文。
  const qs = new Set(echoed.map((q) => q.trim()).filter(Boolean));
  if (!qs.size) return md;
  return md
    .split('\n')
    .filter((line) => !qs.has(line.trim()))
    .join('\n');
}
