import type { ReviewRunTool } from '@meebox/shared';

/**
 * pr-agent prompt assembly: funnels the EXTRA_INSTRUCTIONS injected per tool, the /ask language suffix,
 * and output-echo deduplication into this module, avoiding their scattering across the run-queue exec logic.
 * Pure string construction, with no I/O / runtime dependencies.
 */

/**
 * Translate config.language (ISO locale) into a natural-language prompt directive.
 *
 * CONFIG__RESPONSE_LANGUAGE already suffices for /describe /review (it is embedded in their prompt
 * template), but /ask does not strictly obey it; the explicit prompt reinforces all tools, especially
 * covering the headings / column names / section markers of /ask + table-style output. English (en-US)
 * returns an empty string to avoid adding an unnecessary hint to the LLM. Other unknown locales return
 * empty to preserve pr-agent's original behavior.
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
 * anchor marker directive: make the model explicitly append, at the end of content involving a code location,
 *   [file: <path>, lines: <start_line>-<end_line>]
 *
 * The main path has switched to sitecustomize injecting LocalGitProvider.get_line_link → key_issues rendered
 * as `[**header**](meebox:///<file>#L<s>-L<e>)`, and parse-output takes the structured anchor (path comes from
 * the provider, same source, most reliable). But the #L line numbers still depend on the model filling in
 * pr-agent's native start_line/end_line YAML fields; in practice some models fill only this marker and leave the
 * structured fields empty → the link has only a path. So this marker is kept as a **line-number fallback**: when
 * parse-output merges, it gives the path to the link and fills missing line numbers from the marker's line numbers
 * (resolveIssueAnchor).
 *
 * - /review: **always append** a marker at the end of each key_issue
 * - /ask: **not injected** — /ask uses structured sectioning (see structuredAskDirective), and its suggestion
 *   locations use "the anchor of the referenced finding" (re-evaluation/replacement scenario), so no per-section
 *   marker is needed; forcing per-section markers would flatten the answer into plain-text sections and avoid
 *   tables / code blocks, weakening pr-agent's native /ask rich-text presentation (observed). So this directive
 *   is dropped for /ask, preserving pr-agent's native answering style.
 * - /describe / /improve: not injected — the former produces no issues, the latter uses the marker line
 *   `[file [start-end]](url)` which carries its own anchor
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
 * Layout directive: only changes the line-break layout of each /review key_issue to improve GUI readability,
 * without adding length. pr-agent's original prompt asks for a "short and concise summary", and the model
 * defaults to piling it into a single long run-on paragraph; the render layer (ReactMarkdown + remarkBreaks)
 * faithfully presents it, and a blank-line-separated section becomes an independent <p>. The key is "stay
 * concise" — break only at the semantic boundaries of symptom/impact/suggestion, and do not use sectioning as
 * a pretext to expand the content. Must cooperate with the anchor marker: sectioning stays inside the body,
 * and the marker still occupies the very last line alone.
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
 * /ask structured-sectioning directive: structuring is just **a light wrapper on top of pr-agent's native
 * /ask rich-text answer** — wrapping the answer into the literal three sections `<summary>` / `<analysis>` /
 * `<suggestions>` to help the GUI summarize; the content within each section keeps pr-agent's native
 * presentation (tables / code blocks / sub-headings / lists, depth as usual), without cutting anything down.
 * summary is required (the conclusion, highlighted and expanded in the GUI), analysis is optional (the full
 * process analysis, collapsed by default in the GUI), suggestions is optional (actionable suggestions, **each
 * with a code-location marker** → parsed by the GUI into adoptable "code suggestion" cards). Injected only for
 * /ask; when the model does not comply, parse-output falls back entirely to ordinary parsing (see packages/poller).
 */
function structuredAskDirective(tool: ReviewRunTool, maxCodeSuggestions?: number): string {
  if (tool !== 'ask') return '';
  // Soft constraint on the number of code suggestions: /ask has no pr-agent native cap, so it can only be capped at this prompt layer (shares the same setting with /improve /review).
  const capRule =
    maxCodeSuggestions !== undefined
      ? [
          `- Provide AT MOST ${String(maxCodeSuggestions)} code-anchored suggestions (items that end`,
          '  with a [file: …] marker) in <suggestions>; if more come to mind, keep only the most',
          '  important ones. General (non-code) advice is not counted toward this limit.',
        ]
      : [];
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
    ...capRule,
  ].join('\n');
}

/**
 * /ask re-evaluation-mode directive: injected when this /ask re-evaluates an existing review comment (its body
 * is given via referencedContext). On top of the structured three sections, the model is additionally required
 * to give a `<verdict>` decision — replace (replace: <suggestions> writes a directly publishable replacement
 * comment itself) / keep (the original comment stands) / drop (the original comment does not hold, no comment
 * needed). Drives the adopt / dismiss actions of the result card.
 */
function referencedAskDirective(tool: ReviewRunTool, hasReferencedFinding: boolean): string {
  if (tool !== 'ask' || !hasReferencedFinding) return '';
  return [
    'RE-EVALUATION MODE: You are re-evaluating an EXISTING review comment (its text is',
    'provided in the referenced selection). Decide whether it should stand, be replaced, or be',
    'dropped, and end your answer with EXACTLY ONE verdict tag on its own line:',
    '',
    '  <verdict>replace</verdict>  — the original is wrong / weak / outdated; you will provide a',
    '    better comment to take its place.',
    '  <verdict>keep</verdict>     — the original is valid and should stand as-is.',
    '  <verdict>drop</verdict>     — the original is not warranted (false positive / non-issue);',
    '    no comment is needed.',
    '',
    'Put your conclusion in <summary> and the reasoning (why replace / keep / drop) in <analysis>.',
    '',
    'For <verdict>replace</verdict>, the <suggestions> section MUST contain ONLY the replacement',
    'review comment ITSELF — written as a STANDALONE code-review comment the reviewer can post',
    'AS-IS, in the same voice and structure as a normal review finding: address the code directly;',
    'separate problem → impact → suggested fix with blank lines into a few short paragraphs; be',
    'concise. Do NOT write about the original comment, do NOT say "replace…" / "the original',
    'comment" / "please confirm", and do NOT add meta-commentary or a checklist of questions —',
    'write the comment, not a discussion about it. End it with a single',
    '[file: <path>, lines: <start>-<end>] marker for the referenced code location so it stays',
    'pinned to the same place.',
  ].join('\n');
}

/**
 * /ask code-retrieval guidance (CLI provider only: injected when the subprocess cwd lands in the full worktree
 * and file tools are available). Guides the agentic CLI to use **targeted retrieval** (built-in read-only search
 * / `grep` for symbols · read-only of the needed line ranges) instead of reading whole files and scanning the
 * whole repo, cutting the wasteful cold-start exploration tokens while keeping the depth of reading real files.
 * Deliberately uses a **read-only** tool set only: in headless (no TTY) mode, the default permission mode does
 * not reject non-read-only tools (writes / commands like `rg` not on the built-in read-only allowlist) but
 * **directly aborts the session**, so commands like `rg` must not be induced. The API provider has no file
 * access and is not injected (enabled=false).
 */
function worktreeRetrievalDirective(tool: ReviewRunTool, enabled: boolean): string {
  if (tool !== 'ask' || !enabled) return '';
  return [
    'CODE RETRIEVAL: the full repository worktree is your working directory. Answer efficiently',
    'using your READ-ONLY file tools — do NOT read whole files or scan the whole repo:',
    '- Treat the PR diff above as the source of truth for what changed.',
    '- Locate the specific symbols, definitions, and call sites you need with your built-in file',
    '  search (or the `grep` command); then read only the narrow file ranges the question requires.',
    '- Do NOT run commands that modify files or the system, and avoid non-read-only shell tools',
    '  (e.g. use `grep`, not `rg`); a read-only search plus a targeted read is enough.',
    '- Stop once you have enough context to answer; avoid speculative browsing.',
    'If you have no file tools, just answer from the diff and context above.',
  ].join('\n');
}

/**
 * Assemble the EXTRA_INSTRUCTIONS injected into pr-agent: concatenate in order the language directive / anchor
 * marker / structured sectioning / re-evaluation verdict / layout / PR context / matched rules, skipping empty
 * sections; return undefined when all empty (the caller decides whether to set the env accordingly).
 * - Language directive: CONFIG__RESPONSE_LANGUAGE suffices for /describe /review, but /ask goes through
 *   [pr_questions] and does not strictly obey it, so it must be explicitly reinforced
 * - PR context / rules are read and passed in by the caller (the local provider does not fetch these from the
 *   remote itself)
 */
export function buildExtraInstructions(input: {
  tool: ReviewRunTool;
  language: string;
  prContext: string;
  matchedRuleInstructions: string;
  /** Code snippet the user selected in the Diff (self-describing quote block, already assembled by the render layer), injected only for /ask. */
  referencedContext?: string;
  /** Whether this /ask is a "re-evaluation" of an existing comment; when true, inject the re-evaluation verdict directive (/ask only). */
  referencedFinding?: boolean;
  /** Upper bound on the number of code suggestions (2~8): soft constraint for /ask's <suggestions> (used by /ask only). Empty means no cap. */
  maxCodeSuggestions?: number;
  /** Whether to inject the /ask code-retrieval guidance (CLI provider only: true when the subprocess can use shell/file tools in the full worktree). */
  worktreeRetrieval?: boolean;
}): string | undefined {
  const parts = [
    languageDirectiveFor(input.language),
    anchorMarkerDirective(input.tool),
    structuredAskDirective(input.tool, input.maxCodeSuggestions),
    referencedAskDirective(input.tool, !!input.referencedFinding),
    worktreeRetrievalDirective(input.tool, !!input.worktreeRetrieval),
    reviewLayoutDirective(input.tool),
    input.prContext,
    input.referencedContext ?? '',
    input.matchedRuleInstructions,
  ].filter((s) => s.trim());
  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
}

/** The pr-agent env key corresponding to EXTRA_INSTRUCTIONS (by tool). */
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
 * /ask-specific: put the language requirement as a hard directive at the "end of the question", **written in the
 * target language itself** (which best prompts the model to switch to answering in that language). On the system
 * side, CONFIG__RESPONSE_LANGUAGE / EXTRA_INSTRUCTIONS are often drowned out by large amounts of English diff for
 * free-form Q&A, so require it once more at the end of the user turn (the recency position). en-US / unknown
 * locale returns an empty string (English by default).
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
 * Strip the question echo from /ask output. pr-agent writes the answer artifact as
 *   `### **Ask**❓\n<question>\n\n### **Answer:**\n<answer>`,
 * where `<question>` contains the formatting directives we appended to the end of the question (structured
 * sectioning / anchor / re-evaluation verdict — containing literal **example tags** such as `<summary>` /
 * `<verdict>`); if not stripped, they would pollute downstream structured parsing (parseStructuredAsk would
 * mistake the example tags for the answer).
 *
 * Strategy: preferentially cut at pr-agent's fixed English "Answer" header, taking only the answer after it
 * (discarding the question echo + injected directives together); when the header is missing (version drift),
 * fall back to per-line exact matching to delete the echoed question / language suffix lines.
 */
export function stripAskQuestionEcho(md: string, ...echoed: string[]): string {
  if (!md) return md;
  // pr_questions.py `_prepare_pr_answer` hardcodes the English `### **Answer:**` (not localized by response language).
  const answerRe = /^#{1,6}\s*\*\*\s*Answer\s*:?\s*\*\*\s*$/im;
  const m = answerRe.exec(md);
  if (m) return md.slice(m.index + m[0].length).replace(/^\s+/, '');
  // Fallback: per-line exact matching (whole line after trim == any given string) to delete, keeping the rest of the body.
  const qs = new Set(echoed.map((q) => q.trim()).filter(Boolean));
  if (!qs.size) return md;
  return md
    .split('\n')
    .filter((line) => !qs.has(line.trim()))
    .join('\n');
}
