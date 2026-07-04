import type {
  AskVerdict,
  Finding,
  FindingAnchor,
  FindingCodeChange,
  PrDocSectionKey,
  ReviewRunTool,
} from '@meebox/shared';

export interface ParsedReviewOutput {
  /** Take the first non-empty section title / first line of the description as the PR summary */
  summary?: string;
  findings: Finding[];
  /** The re-review /ask verdict (parsed from the `<verdict>` block); left unset for non-re-review / when not given */
  askVerdict?: AskVerdict;
  /**
   * The pr-agent CLI appears to "complete" (exit 0) but stdout has a marker of a failed LLM call
   * (litellm AuthenticationError / "Failed to generate prediction" etc.). On a hit, the caller should
   * upgrade run.status to 'failed' + errorReason='llm-error', and the UI shows a red failure chip
   * rather than "complete"
   */
  llmFailure?: { message: string };
}

/**
 * Scan stdout for a marker of all LLM calls failing. When pr-agent's fallback retry exhausts all alternate
 * models and still fails, it only logger.error's one line "Failed to <tool> PR: Failed to generate
 * prediction with any model of [...]", and the CLI itself exits 0 without actively failing.
 *
 * The extracted message is kept as concise and readable as possible:
 * - Prefer the last occurrence of "Error during LLM inference: <one-line cause>" (usually the real cause)
 * - Otherwise take the "Failed to <tool> PR: <reason>" line
 * - Neither present but "Failed to generate prediction with any model" is → generic fallback
 *
 * After getting the message, the caller renders it alongside a `[see raw output]` hint, letting the user
 * expand the raw stdout to investigate themselves
 */
export function detectLlmFailure(stdout: string): { message: string } | null {
  const text = stripAnsi(stdout);
  const hasFailMarker =
    /Failed to generate prediction with any model/i.test(text) ||
    /Failed to (review|describe|ask|improve) PR/i.test(text) ||
    /Error during LLM inference/i.test(text);
  if (!hasFailMarker) return null;

  // Prefer extracting the most substantive cause from "Error during LLM inference: <one-line content>"
  const inferenceMatches = [...text.matchAll(/Error during LLM inference:\s*([^\n]+)/gi)];
  if (inferenceMatches.length > 0) {
    const last = inferenceMatches[inferenceMatches.length - 1]![1]!.trim();
    return { message: last };
  }
  // Fall back to the "Failed to <tool> PR: ..." line
  const toolMatch = /Failed to (?:review|describe|ask|improve) PR:\s*([^\n]+)/i.exec(text);
  if (toolMatch) return { message: toolMatch[1]!.trim() };
  // Generic fallback
  return { message: '所有备选模型均调用失败 (Failed to generate prediction with any model)' };
}

/**
 * Strip ANSI escape codes from text. When pr-agent runs in a container, stdout also carries color (due to logger
 * config), and parsing / landing in a finding body / rendering via react-markdown should not carry `\x1b[...m`.
 * The live stream goes through ChatPane's AnsiPre parsing, which preserves ANSI; this only handles "persistence / parsing".
 *
 * Also strips common control sequences like CSI (`ESC [ ... letter`) and OSC (`ESC ] ... BEL/ST`).
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b\[[\d;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, '');
}

interface Section {
  /** Markdown header level 1-6 */
  level: number;
  title: string;
  body: string;
}

/**
 * Slice pr-agent 0.36.0's markdown output into sections by H1-H6.
 * Each section has level / title / body (body has leading/trailing whitespace stripped).
 * Leading content at the top with no header is also synthesized into a level=0 / title='' section, so /describe
 * can be pulled out as a whole segment.
 */
export function splitMarkdownSections(md: string): Section[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const sections: Section[] = [];
  let cur: Section | null = { level: 0, title: '', body: '' };
  const HEADER_RE = /^(#{1,6})\s+(.+?)\s*$/;
  for (const line of lines) {
    const m = HEADER_RE.exec(line);
    if (m) {
      // First finalize the prev section (drop empty segments)
      if (cur && (cur.title || cur.body.trim())) {
        sections.push({ ...cur, body: cur.body.trim() });
      }
      cur = { level: m[1]!.length, title: m[2]!.trim(), body: '' };
    } else if (cur) {
      cur.body += `${line}\n`;
    }
  }
  if (cur && (cur.title || cur.body.trim())) {
    sections.push({ ...cur, body: cur.body.trim() });
  }
  return sections;
}

/** Strip markdown emphasis marks (`**Foo**` → `Foo`), used for title display + normalized comparison */
function normalizeTitle(t: string): string {
  return t.replace(/[*_]+/g, '').trim();
}

/** The internal branch name our materializeWorktree temporarily creates (`pr-<localId>/head|base`), which pr-agent leaks as a PR identifier */
const INTERNAL_BRANCH_RE = /pr-[\w-]+\/(head|base)\b/i;

/**
 * Strip "noise lines" from the head and tail of body: consecutive markdown HR (`---` / `***` / `___`), blank lines,
 * and whole lines that are just the `pr-<localId>/head|base` internal branch name leak. pr-agent separates paragraphs
 * with `---`, and after splitMarkdownSections this HR sticks to the end of the previous section's body; similarly a
 * PR identifier leak like pr-<localId>/head may also land at the head or tail of body.
 * All cleaned at the parser layer, so downstream / rendering / capsule splitting need not care.
 */
function trimNoise(body: string): string {
  const isNoise = (l: string): boolean => {
    const trimmed = l.trim();
    if (trimmed === '') return true;
    if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) return true; // markdown HR
    if (INTERNAL_BRANCH_RE.test(trimmed) && trimmed.length < 40) return true; // short line + contains branch name
    return false;
  };
  const lines = body.split('\n');
  while (lines.length > 0 && isNoise(lines[0]!)) lines.shift();
  while (lines.length > 0 && isNoise(lines[lines.length - 1]!)) lines.pop();
  return lines.join('\n');
}

/**
 * Map a normalized title to a stable sectionKey. Matching uses lower-case + regex, covering the common spellings
 * across pr-agent versions / /describe vs /review / Chinese-English variants.
 *
 * When maintaining and adding a key: add it to the PrDocSectionKey type, and add a [regex, key] entry to this table.
 */
const SECTION_KEY_PATTERNS: ReadonlyArray<readonly [RegExp, PrDocSectionKey]> = [
  [/^(?:suggested[\s_-]+)?title$/i, 'title'],
  [/^pr[\s_-]*type$/i, 'pr-type'],
  [/^type$/i, 'pr-type'],
  [/^(?:pr[\s_-]+reviewer[\s_-]+guide|review[\s_-]+summary|summary)$/i, 'summary'],
  [/^description$/i, 'description'],
  // "Diagram Walkthrough" → diagram (contains the walkthrough substring, so must precede walkthrough)
  [/diagram/i, 'diagram'],
  // Injected high-level assessment section (the shim adds an assessment field to the describe schema → rendered as `### **Assessment**`)
  [/^(?:high[\s_-]+level[\s_-]+)?assessment$/i, 'assessment'],
  [/^walkthrough$/i, 'walkthrough'],
  // The <strong> text of the tests/security sections varies with the conclusion (hardcoded in pr-agent templates, always English):
  //   tests: Relevant tests / PR contains tests / No relevant tests[ found]
  //   security: Security concerns / No security concerns[ identified]
  // Matching only "Relevant tests"/"Security concerns" would miss common conclusions like "has tests" / "no security risk" → degrading to general.
  [
    /^(?:relevant[\s_-]+tests?|pr[\s_-]+contains[\s_-]+tests?|no[\s_-]+relevant[\s_-]+tests?(?:[\s_-]+found)?)$/i,
    'relevant-tests',
  ],
  [/^(?:no[\s_-]+)?security[\s_-]+concerns?(?:[\s_-]+identified)?$/i, 'security'],
  [/^estimated[\s_-]+effort.*$/i, 'effort'],
  [/^(?:code[\s_-]+quality[\s_-]+)?score$/i, 'score'],
];

function mapSectionKey(displayTitle: string): PrDocSectionKey | undefined {
  // Strip leading/trailing emoji / punctuation / whitespace, so a decorated title like `⏱️ Estimated effort to review: 3 🔵🔵`
  // can also hit the English anchor words in SECTION_KEY_PATTERNS
  const cleaned = displayTitle.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim();
  for (const [re, key] of SECTION_KEY_PATTERNS) {
    if (re.test(cleaned)) return key;
  }
  return undefined;
}

/**
 * Noise sections, removed directly from findings:
 * - `user description`: purely echoes the PR description the user already wrote, which PrInfoView already displays in the UI
 * - title containing `pr-<localId>/head|base`: the branch name we temporarily create, which pr-agent leaks as a PR identifier
 *   at heading levels (matches even with emoji / decoration — a substring is enough)
 * - empty title + empty body after trimNoise: a standalone section that is a pure branch-name leak
 * - the `question` / `questions` section under the /ask tool: the chat-user-msg above in the UI already shows the user's question,
 *   so pr-agent echoing the question in the answer text is redundant
 */
const SKIP_TITLES = new Set(['user description']);
const ASK_QUESTION_HEADERS = new Set(['ask', 'question', 'questions', '问题', '提问']);
const ASK_ANSWER_HEADERS = new Set(['answer', 'answers', '回答', '答案', '解答']);

/**
 * Detect structural headers in /ask output: pr-agent echoes title segments like "Ask ❓" / "Answer:", which are redundant
 * for the UI (the question is already shown in the bubble above, and the answer follows right below). Strip leading/trailing
 * emoji / punctuation / whitespace first, then match against the sets.
 */
function askHeaderKind(title: string): 'question' | 'answer' | null {
  const t = normalizeTitle(title)
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .toLowerCase();
  if (ASK_QUESTION_HEADERS.has(t)) return 'question';
  if (ASK_ANSWER_HEADERS.has(t)) return 'answer';
  return null;
}

function shouldSkipSection(sec: Section, tool: ReviewRunTool): boolean {
  const t = normalizeTitle(sec.title).toLowerCase();
  if (SKIP_TITLES.has(t)) return true;
  if (tool === 'ask') {
    const kind = askHeaderKind(sec.title);
    // Question-echo segments like "Ask ❓" are removed entirely; an empty "Answer" header segment (title only, no body) is also removed.
    if (kind === 'question') return true;
    if (kind === 'answer' && !trimNoise(sec.body).trim()) return true;
  }
  // title contains an internal branch name (e.g., "pr-<id>/head" / "pr-<id>/head 🔍" / "## pr-<id>/base")
  if (INTERNAL_BRANCH_RE.test(t)) return true;
  // After trimNoise strips the leading/trailing HR / branch-name leak, an empty body = the whole segment is noise
  const cleanedBody = trimNoise(sec.body).trim();
  if (!t && !cleanedBody) return true;
  return false;
}

/**
 * Determine whether a section is pr-agent `/review`'s key_issues_to_review segment.
 *
 * When pr-agent v0.35+ LocalGitProvider runs /review, this segment renders as:
 *   ### ⚡ Recommended focus areas for review
 *   ####                       <- a standalone empty H4 line as an inter-issue separator
 *   **Potential null reference**   <- issue_header (bold)
 *
 *   <issue_content multi-line text>
 *   ####
 *   **<next header>**
 *   ...
 *
 * This only recognizes the section title. Expanding into multiple findings goes through expandKeyIssuesSection.
 */
function isKeyIssuesSection(title: string): boolean {
  return /key\s+issues\s+to\s+review|recommended\s+focus\s+areas\s+for\s+review|关键问题|关注焦点/i.test(
    title,
  );
}

/**
 * Split the "Recommended focus areas for review" segment's body into multiple findings by issue.
 *
 * Split anchor: **a standalone line + a bold-wrapped issue header** (e.g. `**Potential null reference**`). Each issue's
 * content spans from the line after its bold header to the next bold header line.
 * The `####` empty-title separator is skipped (splitMarkdownSections does not split empty titles); content
 * before the first header (usually just `####`) is discarded.
 *
 * anchor extraction: the embedded runtime's sitecustomize already patches LocalGitProvider.get_line_link
 * (returning `meebox:///<file>#L<s>-L<e>`), so the header renders as `[**header**](meebox://…)`, from which
 * a structured anchor can be extracted directly (same source as the real provider, near-full per-issue coverage).
 * When the link is missing (old runtime / truly no anchor), fall back to best-effort inference from the issue text:
 * the old marker `[file:…, lines:…]`, or `path/to/file.ext` + `第 N 行 / lines N-M` keywords. When nothing can be
 * extracted the anchor is left empty, and the UI disables the "jump to edit" button.
 */
function expandKeyIssuesSection(sec: Section, baseIndex: number, tool: ReviewRunTool): Finding[] {
  const body = trimNoise(sec.body);
  const lines = body.split('\n');
  // Two forms of the issue header line:
  //   - no link (old version / truly no anchor): the whole line is `**header**`
  //   - with link (get_line_link patched by sitecustomize): `[**header**](meebox:///file#Ls-Le)`
  const HEADER_LINE_RE = /^\s*\*\*\s*([^*\n][^*\n]*?)\s*\*\*\s*$/;
  const LINKED_HEADER_RE = /^\s*\[\s*\*\*\s*([^*\n][^*\n]*?)\s*\*\*\s*\]\(\s*([^)\s]+)\s*\)\s*$/;
  interface IssueBlock {
    title: string;
    body: string;
    /** The link carried by the header line (e.g. meebox://…); used to extract a structured anchor */
    link?: string;
  }
  const blocks: IssueBlock[] = [];
  let cur: IssueBlock | null = null;
  for (const line of lines) {
    const lm = LINKED_HEADER_RE.exec(line);
    const m = lm ? null : HEADER_LINE_RE.exec(line);
    if (lm || m) {
      if (cur) blocks.push(cur);
      cur = lm
        ? { title: lm[1]!.trim(), body: '', link: lm[2] }
        : { title: m![1]!.trim(), body: '' };
      continue;
    }
    if (cur) {
      // Skip the empty H4 separator between issue blocks (splitMarkdownSections does not split a `#### ` empty title;
      // drop directly when the whole line is `#` + whitespace; a residual `#` in the body has no effect)
      if (/^#{2,}\s*$/.test(line.trim())) continue;
      cur.body += `${line}\n`;
    }
  }
  if (cur) blocks.push(cur);

  if (blocks.length === 0) {
    // No bold header found at all in body (old version / prompt drift) → fall back to the whole segment as one finding
    return [sectionToFinding(sec, baseIndex, tool)];
  }

  return blocks.map((b, i) => {
    const raw = b.body.trim();
    // First parse the anchor from the raw text containing the marker (the marker is a line-number fallback), then strip for display
    const anchor = resolveIssueAnchor(b.link, raw);
    const issueBody = stripAnchorMarker(raw);
    const id = `${tool}-${String(baseIndex + i).padStart(3, '0')}`;
    return {
      id,
      category: 'code-feedback' as const,
      sectionKey: 'code-feedback' as const,
      title: b.title,
      body: issueBody,
      ...(anchor ? { anchor } : {}),
    };
  });
}

// ===== GFM output parsing (gfm_markdown=True: the shim makes LocalGitProvider support GFM, so /describe
// emits mermaid diagrams and /review uses GFM rich markdown). Under GFM /review is a whole <table>, with each
// segment being one <tr><td>…<strong>title</strong>…</td></tr>; a finding inside the key_issues segment is
//   <details><summary><a href='meebox://…'><strong>title</strong></a>\n\ncontent\n</summary>\n\ncode snippet\n\n</details>
// or <a href='meebox://…'><strong>title</strong></a><br>content. markdown H1-H6 slicing mismatches it,
// so this HTML parsing path is used instead (only for review + when GFM is detected).

/**
 * Whether the output is GFM table-form /review (decides the HTML vs markdown parsing path).
 *
 * Decision: contains a closed `<table>…</table>` and at least one `<td>`/`<th>` cell. Before deciding, strip code
 * fences (```…```), to avoid "markdown body mentioning `<table>` inside a code block" being misjudged into the HTML path.
 *
 * Note: must not require "starts with <table>" — real GFM /review often carries a leading sentence before the table
 * (e.g. "The following are key observations to aid the review:"); forcibly anchoring the start would misjudge, causing
 * the whole table to degrade into a single summary and key_issues to no longer split into standalone code-feedback.
 */
function isGfmReviewOutput(text: string): boolean {
  const withoutFences = text.replace(/```[\s\S]*?```/g, '');
  return (
    /<table[\s>]/i.test(withoutFences) &&
    /<\/table>/i.test(withoutFences) &&
    /<(?:td|th)\b/i.test(withoutFences)
  );
}

/** GFM finding fragment → renderable text: <br>/<summary>/<details> → newline, other tags stripped,
 *  common entities decoded; code fences (```) are literal text, preserved as-is. */
function gfmInlineToText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:summary|details)[^>]*>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Split a GFM <table> into row sections: the content of **all** cells (<td>/<th>) within each <tr>, the leading <strong>
 *  as title and the rest as body (the body of a key_issues row keeps the raw HTML for expandGfmKeyIssues to extract findings). */
function splitGfmTableSections(html: string): Section[] {
  const sections: Section[] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(html)) !== null) {
    const row = rm[1]!;
    // Collect all cells in the row and join with \n\n: a multi-column table does not drop subsequent cell content (taking only the first <td> would miss review items).
    const cellRe = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
    const cells: string[] = [];
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(row)) !== null) cells.push(cm[1]!);
    const cellText = cells.length > 0 ? cells.join('\n\n') : row;
    const titleMatch = /<strong>([\s\S]*?)<\/strong>/i.exec(cellText);
    const title = titleMatch
      ? gfmInlineToText(titleMatch[1]!)
          .replace(/[:：]\s*$/, '')
          .trim()
      : '';
    // `<strong>title</strong>: value` form: the leading separator (: ：&nbsp; whitespace) left after removing the title
    const body = (titleMatch ? cellText.slice(titleMatch.index + titleMatch[0].length) : cellText)
      .replace(/^(?:&nbsp;|\s|[:：])+/gi, '')
      .trim();
    sections.push({ level: 3, title, body });
  }
  return sections;
}

/** Extract multiple findings from the GFM key_issues segment body (raw HTML): anchoring on <a href><strong>title</strong></a>,
 *  the text between two adjacent ones is that finding's body. The link yields the structured anchor, same source as the markdown path. */
function expandGfmKeyIssues(html: string, baseIndex: number, tool: ReviewRunTool): Finding[] {
  const FIND_RE = /<a\s+href=['"]([^'"]+)['"]\s*>\s*<strong>([\s\S]*?)<\/strong>\s*<\/a>/gi;
  const matches = [...html.matchAll(FIND_RE)];
  return matches.map((m, i) => {
    const link = m[1]!;
    const title = gfmInlineToText(m[2]!).trim();
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index : html.length;
    let chunk = html.slice(start, end);
    // <details> form: issue_content is before </summary>; after it is the relevant_lines code snippet,
    // which is not put into body (the code is shown via anchor → DiffView; re-pasting a large code block in body is noisy).
    const sumIdx = chunk.search(/<\/summary>/i);
    if (sumIdx >= 0) chunk = chunk.slice(0, sumIdx);
    const raw = gfmInlineToText(chunk);
    // First parse the anchor from the raw text containing the marker (line-number fallback), then strip for display
    const anchor = resolveIssueAnchor(link, raw);
    const issueBody = stripAnchorMarker(raw);
    return {
      id: `${tool}-${String(baseIndex + i).padStart(3, '0')}`,
      category: 'code-feedback' as const,
      sectionKey: 'code-feedback' as const,
      title,
      body: issueBody,
      ...(anchor ? { anchor } : {}),
    };
  });
}

/**
 * Best-effort extract a file path + line number from the issue text. After pr-agent rendering loses the fields this is
 * the only fallback route: scan the content once, finding (1) a path token containing `/` or `\` or `.<ext>`,
 * (2) a line number in the form `第 N 行 / 行 N-M / line(s) N-M / Lines N-M`. Returns undefined when nothing is extracted.
 *
 * We also recognize the marker we ourselves ask the model to output explicitly in the prompt extra-instructions:
 *   [file: <path>, lines: <start>-<end>]
 * used as a strong anchor signal (preferentially adopted)
 */
/**
 * Parse the anchor link injected by sitecustomize `meebox:///<url-encoded-file>#L<s>-L<e>`
 * (the line-number part is optional; end may be omitted). A non-meebox link (a real provider's http link) returns undefined,
 * handing back to text inference. path is URL-decoded to restore spaces / non-ASCII.
 */
function parseMeeboxAnchor(url: string): FindingAnchor | undefined {
  const m = /^meebox:\/{0,3}([^#?]+)(?:#L(\d+)(?:-L(\d+))?)?\s*$/i.exec(url.trim());
  if (!m) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(m[1]!).replace(/^\/+/, '').trim();
  } catch {
    path = m[1]!.replace(/^\/+/, '').trim();
  }
  if (!path) return undefined;
  const anchor: FindingAnchor = { path };
  if (m[2]) anchor.startLine = Number.parseInt(m[2], 10);
  if (m[3]) anchor.endLine = Number.parseInt(m[3], 10);
  return anchor;
}

/**
 * Merge the two anchor signals to get the most complete location:
 *   - meebox link (injected by sitecustomize, path from the same source as the provider, most reliable)
 *   - text inference (the original `[file:…, lines:…]` marker protocol / path+line-number fallback)
 *
 * Rules: the link's path is authoritative; a line-number-bearing link takes priority (the model filled structured start/end
 * → the link carries #L), and when the link lacks line numbers, fall back to completing with the text protocol's line numbers —
 * but only when the text points at the same file, to avoid cross-file mismatch. This gets a reliable path while not losing
 * the line numbers from when the model only wrote them into the marker without filling structured fields.
 */
function resolveIssueAnchor(link: string | undefined, body: string): FindingAnchor | undefined {
  const linkAnchor = link ? parseMeeboxAnchor(link) : undefined;
  const textAnchor = inferAnchorFromIssueText(body);
  if (!linkAnchor) return textAnchor;
  if (linkAnchor.startLine != null) return linkAnchor;
  if (textAnchor?.startLine != null && (!textAnchor.path || textAnchor.path === linkAnchor.path)) {
    return {
      path: linkAnchor.path,
      startLine: textAnchor.startLine,
      ...(textAnchor.endLine != null ? { endLine: textAnchor.endLine } : {}),
    };
  }
  return linkAnchor;
}

/** Anchor marker `[file: <path>, lines: <s>-<e>]` (injected by our prompt). After being extracted into an anchor it
 *  should be removed from the display body, otherwise it leaks into the finding text as stray text.
 *  The path itself may contain `[]` (e.g. `a/[m-123]/x.ts`): when lines are present, delimit with a lazy `.+?` + the
 *  mandatory `, lines:` suffix (`.` can match `]`, so the `]` in the path is no longer wrongly cut); without lines, fall back to the old form excluding `]`. */
const ANCHOR_MARKER_RE =
  /\[\s*file\s*:\s*(?:.+?\s*,\s*lines?\s*:\s*\d+(?:\s*[-–—]\s*\d+)?|[^,\]\n]+?)\s*\]/gi;

/** Remove the anchor marker from the finding body and collapse excess whitespace. */
export function stripAnchorMarker(body: string): string {
  return body
    .replace(ANCHOR_MARKER_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inferAnchorFromIssueText(text: string): FindingAnchor | undefined {
  // Explicit marker (injected by our prompt). With lines, delimit the path with a lazy `.+?` + the mandatory `, lines:` suffix,
  // allowing the path to contain `[]` (`.` matches `]`, not wrongly cut by the `]` in the path); without lines, fall back to the old form excluding `]`.
  const markerWithLines =
    /\[\s*file\s*:\s*(.+?)\s*,\s*lines?\s*:\s*(\d+)(?:\s*[-–—]\s*(\d+))?\s*\]/i;
  const markerNoLines = /\[\s*file\s*:\s*([^,\]\s][^,\]]*?)\s*\]/i;
  const mm = markerWithLines.exec(text) ?? markerNoLines.exec(text);
  if (mm) {
    const path = stripBackticks(mm[1]!.trim());
    const anchor: FindingAnchor = { path };
    if (mm[2]) anchor.startLine = Number.parseInt(mm[2], 10);
    if (mm[3]) anchor.endLine = Number.parseInt(mm[3], 10);
    return anchor;
  }
  // Fallback 1: a path token containing `/` (preferentially matching `path/to/file.ext`)
  const pathRe =
    /(?:^|[\s(`'"])([A-Za-z0-9_./\\-]+\/[A-Za-z0-9_./\\-]*\.[A-Za-z0-9]{1,8})(?=[\s)`'":.,!?]|$)/m;
  const pm = pathRe.exec(text);
  if (pm) {
    const path = pm[1]!;
    const anchor: FindingAnchor = { path };
    const lineRe =
      /(?:第\s*(\d+)(?:\s*[-–—]\s*(\d+))?\s*行|行号?\s*[:：]?\s*(\d+)(?:\s*[-–—]\s*(\d+))?|lines?\s*[:：]?\s*(\d+)(?:\s*[-–—]\s*(\d+))?)/i;
    const lm = lineRe.exec(text);
    if (lm) {
      const start = lm[1] ?? lm[3] ?? lm[5];
      const end = lm[2] ?? lm[4] ?? lm[6];
      if (start) anchor.startLine = Number.parseInt(start, 10);
      if (end) anchor.endLine = Number.parseInt(end, 10);
    }
    return anchor;
  }
  return undefined;
}

/**
 * Parse a single markdown segment into a Finding. Recognizes pr-agent's common
 * `**File:** path` + `**Lines:** N-M` pattern → code-feedback; otherwise returns general / description.
 */
export function sectionToFinding(sec: Section, index: number, tool: ReviewRunTool): Finding {
  const id = `${tool}-${String(index).padStart(3, '0')}`;
  const body = trimNoise(sec.body);
  const rawTitle = normalizeTitle(sec.title) || undefined;
  const mappedKey = rawTitle ? mapSectionKey(rawTitle) : undefined;
  // /ask: an "Answer" header with body is redundant (the answer text follows right below) → clear the title, keep only the body.
  const displayTitle =
    tool === 'ask' && askHeaderKind(sec.title) === 'answer' ? undefined : rawTitle;

  // pr-agent 0.36.0 review output looks like (with a pr-agent custom prompt or a non-LocalGitProvider):
  //   **File:** src/foo.ts
  //   **Lines:** 42-50
  //   **Issue:** ...
  // Compatible with Chinese-English variants like file_path / Line / 行号
  const fileMatch = /^\s*\*\*\s*(?:file(?:[_\s]?path)?|路径|文件)\s*:?\s*\*\*\s*(.+?)\s*$/im.exec(
    body,
  );
  const file = fileMatch?.[1]?.trim();
  if (file) {
    const anchor: FindingAnchor = { path: stripBackticks(file) };
    const linesMatch =
      /^\s*\*\*\s*(?:lines?|line[_\s]?numbers?|行号?)\s*:?\s*\*\*\s*(.+?)\s*$/im.exec(body);
    const linesText = linesMatch?.[1]?.trim();
    if (linesText) {
      const range = /(\d+)\s*(?:[-–—]\s*(\d+))?/.exec(linesText);
      if (range) {
        anchor.startLine = Number.parseInt(range[1]!, 10);
        if (range[2]) anchor.endLine = Number.parseInt(range[2], 10);
      }
    }
    return {
      id,
      category: 'code-feedback',
      sectionKey: 'code-feedback',
      title: displayTitle,
      body,
      anchor,
    };
  }

  // /ask fallback: pr-agent /ask free-form answers do not output in a structured format like `**File:** xxx`,
  // but our prompt injects a `[file: <path>, lines: <s>-<e>]` marker requiring the model to annotate explicitly
  // when the answer involves a code location. On a marker hit it is upgraded to code-feedback — the UI shows a
  // "→ edit" button jumping straight to a DiffView inline-comment draft, so /ask question answers can also convert
  // into a publishable inline comment (consistent with the /review path).
  // Enabled only for /ask: if /describe's description segment happens to mention a path it should not be recognized as
  // code-feedback; /review's regular segments should also not be covered by this fallback
  if (tool === 'ask') {
    const anchor = inferAnchorFromIssueText(body);
    if (anchor && typeof anchor.startLine === 'number') {
      return {
        id,
        category: 'code-feedback',
        sectionKey: 'code-feedback',
        title: displayTitle,
        body,
        anchor,
      };
    }
  }

  return {
    id,
    category: tool === 'describe' ? 'description' : 'general',
    sectionKey: mappedKey ?? 'general',
    title: displayTitle,
    body,
  };
}

// ===== /describe's File Walkthrough handling =====
// pr-agent appends File Walkthrough as an HTML <details><table> at the end of describe (line 131),
// with no markdown header, so it sticks into the previous segment's body (usually ### Diagram Walkthrough). Here it is
// extracted separately, and the nested table is converted into a "grouped-collapsible unordered list" (tables are a poor
// experience in the chat panel), while dropping the meaningless +1/-1 stats column.

/**
 * Extract the File Walkthrough block from describe output (appended at the end, containing nested details, so taken from start to end).
 * Returns { rest: the body with the block removed, block: the block's raw text }; null if absent.
 */
function extractFileWalkthrough(md: string): { rest: string; block: string } | null {
  const startRe = /<details[^>]*>\s*<summary>\s*<h3>\s*File Walkthrough\s*<\/h3>\s*<\/summary>/i;
  const m = startRe.exec(md);
  if (!m) return null;
  return { rest: md.slice(0, m.index).trimEnd(), block: md.slice(m.index) };
}

/** HTML text-node escaping: after gfmInlineToText decodes entities into bare < > & in desc/filenames,
 *  putting them into an <li> text context requires re-escaping, to avoid breaking the structure / being misjudged by the downstream sanitizer. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convert File Walkthrough's nested HTML table into pure HTML as a "by-category collapsible unordered list":
 *   <details open><summary>category name（N）</summary>
 *   <ul><li><strong>filename</strong> — description</li>…</ul>
 *   </details>
 * Preserves pr-agent's multi-level categories (each category is its own collapsible/expandable <details>), dropping the
 * meaningless +1/-1 link column after each row. Categories are recognized by "<strong>X</strong></td><td><details|table>" —
 * pr-agent only wraps a category in a <details> when the file count exceeds a threshold (collapsible_file_list=adaptive),
 * while a small PR is a bare <td><table>; both must be recognized, otherwise a small PR would fail to recognize categories
 * and degrade into a flat list. Files are recognized by "<strong>X</strong><dd><code>desc</code>", assigned to the owning
 * category by position of appearance.
 *
 * Note: produces pure HTML (not a markdown `- ` list) — "a markdown list nested inside a <details> raw HTML block" does not
 * reliably render as a collapsible region under react-markdown(rehype-raw); only pure HTML ensures reliable collapse at each level.
 */
function walkthroughToList(block: string): string {
  const GROUP_RE = /<strong>([^<]+?)<\/strong>\s*<\/td>\s*<td>\s*<(?:details|table)\b/gi;
  const FILE_RE = /<strong>([^<]+?)<\/strong>\s*<dd>\s*<code>([\s\S]*?)<\/code>/gi;
  const groups = [...block.matchAll(GROUP_RE)].map((g) => ({ index: g.index, name: g[1]!.trim() }));
  const files = [...block.matchAll(FILE_RE)].map((f) => ({
    index: f.index,
    name: f[1]!.trim(),
    desc: gfmInlineToText(f[2]!).replace(/\s+/g, ' ').trim(),
  }));
  const fmtItem = (f: { name: string; desc: string }): string =>
    `<li><strong>${escapeHtml(f.name)}</strong>${f.desc ? ` — ${escapeHtml(f.desc)}` : ''}</li>`;
  const fmtList = (items: ReadonlyArray<{ name: string; desc: string }>): string =>
    `<ul>\n${items.map(fmtItem).join('\n')}\n</ul>`;

  if (groups.length === 0) {
    // No categories: a flat list directly
    return files.length ? fmtList(files) : '（无文件变更明细）';
  }
  const parts: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const next = i + 1 < groups.length ? groups[i + 1]!.index : Infinity;
    const inGroup = files.filter((f) => f.index > g.index && f.index < next);
    if (inGroup.length === 0) continue;
    parts.push(
      `<details open><summary>${escapeHtml(g.name)}（${String(inGroup.length)}）</summary>\n${fmtList(
        inGroup,
      )}\n</details>`,
    );
  }
  return parts.join('\n') || (files.length ? fmtList(files) : '（无文件变更明细）');
}

/** /ask structured-segment tags → sectionKey (fixed render order: summary → analysis → suggestions). */
const ASK_STRUCTURED_SECTIONS: ReadonlyArray<{ tag: string; key: PrDocSectionKey }> = [
  { tag: 'summary', key: 'ask-summary' },
  { tag: 'analysis', key: 'ask-analysis' },
  { tag: 'suggestions', key: 'ask-suggestions' },
];

/** Take the body of a `<tag>…</tag>` block (removing the anchor marker + noise); undefined if empty. Case-insensitive, multi-line.
 *  The summary / analysis segments are plain-text display, so the marker is reading noise and is stripped first. */
function extractAskSection(md: string, tag: string): string | undefined {
  const m = extractAskSectionRaw(md, tag);
  if (!m) return undefined;
  const body = trimNoise(stripAnchorMarker(m));
  return body || undefined;
}

/** Take the raw body of a `<tag>…</tag>` block (removing only leading/trailing noise, **keeping the anchor marker**); undefined if empty.
 *  The suggestions segment needs the marker to split entries / locate, so it uses the raw body. */
function extractAskSectionRaw(md: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}\\s*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i');
  const m = re.exec(md);
  if (!m) return undefined;
  const body = trimNoise(m[1] ?? '');
  return body || undefined;
}

/**
 * Parse the `<suggestions>` segment into a finding list: anchoring on the anchor marker, split suggestions entry by entry —
 * entries with a line-number marker are upgraded to `code-suggestion` (with an anchor; the UI shows code location + edit /
 * reject / quote, and it can be adopted as an inline comment), and the remaining text is merged into a plain `ask-suggestions`.
 * No marker at all → the whole segment as one `ask-suggestions` (same as the old behavior). idx is numbered from baseIndex.
 */
function parseAskSuggestions(body: string, baseIndex: number): Finding[] {
  const pad = (n: number): string => String(n).padStart(3, '0');
  const matches = [...body.matchAll(ANCHOR_MARKER_RE)];
  if (matches.length === 0) {
    const clean = trimNoise(stripAnchorMarker(body));
    return clean
      ? [{ id: `ask-${pad(baseIndex)}`, category: 'general', sectionKey: 'ask-suggestions', body: clean }]
      : [];
  }
  const findings: Finding[] = [];
  let cursor = 0;
  let idx = baseIndex;
  for (const m of matches) {
    const end = (m.index ?? 0) + m[0].length;
    const chunk = trimNoise(stripAnchorMarker(body.slice(cursor, end)));
    cursor = end;
    if (!chunk) continue;
    const anchor = inferAnchorFromIssueText(m[0]);
    const located = anchor != null && typeof anchor.startLine === 'number';
    findings.push({
      id: `ask-${pad(idx)}`,
      category: located ? 'code-feedback' : 'general',
      sectionKey: located ? 'code-suggestion' : 'ask-suggestions',
      body: chunk,
      ...(located ? { anchor } : {}),
    });
    idx += 1;
  }
  // The tail text after the last marker (no marker) is merged into one plain suggestion.
  const tail = trimNoise(stripAnchorMarker(body.slice(cursor)));
  if (tail) {
    findings.push({ id: `ask-${pad(idx)}`, category: 'general', sectionKey: 'ask-suggestions', body: tail });
  }
  return findings;
}

/** Extract the re-review /ask's `<verdict>replace|keep|drop</verdict>` (case / whitespace tolerant). undefined if absent / unrecognized. */
function extractAskVerdict(md: string): AskVerdict | undefined {
  const m = /<verdict\s*>([\s\S]*?)<\/verdict\s*>/i.exec(md);
  const v = m?.[1]?.trim().toLowerCase();
  return v === 'replace' || v === 'keep' || v === 'drop' ? v : undefined;
}

/**
 * /ask structured-segment parsing: split the three segments `<summary>` / `<analysis>` / `<suggestions>` that the
 * prompt injection requires the model to output into standalone findings (each with an ask-* sectionKey, by which the UI
 * colors / collapses / sorts). The first line of the summary body doubles as ParsedReviewOutput.summary.
 *
 * Fallback: no paired tag appears, or all tags are empty → return null, and the caller goes through ordinary /ask markdown
 * parsing (not breaking existing behavior when the model does not follow the structured instruction).
 */
export function parseStructuredAsk(stdout: string): ParsedReviewOutput | null {
  const md = stripAnsi(stdout);
  // There must be at least one recognized pair of open/close tags, otherwise treat as unstructured output and fall back.
  if (!/<(summary|analysis|suggestions)\s*>[\s\S]*?<\/\1\s*>/i.test(md)) return null;
  const findings: Finding[] = [];
  let summary: string | undefined;
  let idx = 0;
  for (const { tag, key } of ASK_STRUCTURED_SECTIONS) {
    // suggestions segment special handling: split entry by entry by the anchor marker (those with line numbers upgraded to a locatable code-suggestion).
    if (tag === 'suggestions') {
      const raw = extractAskSectionRaw(md, tag);
      if (!raw) continue;
      const sug = parseAskSuggestions(raw, idx);
      findings.push(...sug);
      idx += sug.length;
      continue;
    }
    const body = extractAskSection(md, tag);
    if (!body) continue;
    findings.push({
      id: `ask-${String(idx).padStart(3, '0')}`,
      category: 'general',
      sectionKey: key,
      body,
    });
    idx += 1;
    if (key === 'ask-summary')
      summary = body
        .split('\n')
        .map((l) => l.trim())
        .find(Boolean);
  }
  if (findings.length === 0) return null; // tags present but all empty → fall back
  const askVerdict = extractAskVerdict(md);
  return { findings, ...(summary ? { summary } : {}), ...(askVerdict ? { askVerdict } : {}) };
}

/**
 * Parse pr-agent stdout into a findings list. M3-B2 is best-effort:
 * - split markdown sections
 * - skip noise sections (temporary branch-name leak / user description echo)
 * - recognize the file + lines pattern and mark code-feedback
 * - map known section titles to sectionKey, used by the UI for sorting / coloring
 *
 * /improve goes through a dedicated parsing path: the pr-agent local provider outputs a nested HTML <details> structure
 * rather than pure markdown sections, which splitMarkdownSections cannot split.
 *
 * Failure / empty output / a completely irregular format → findings is an empty array, and the caller can fall back to
 * showing the raw stdout. No error is thrown here.
 */
export function parseReviewOutput(stdout: string, tool: ReviewRunTool): ParsedReviewOutput {
  // LLM failure detection first: on failure there may still be partial sections (e.g., a logger marker from a previous round),
  // so let findings parsing run to completion, but the llmFailure field marks it so the upper layer decides status='failed'
  const llmFailure = detectLlmFailure(stdout) ?? undefined;

  if (tool === 'improve') {
    const out = parseImproveOutput(stdout);
    return llmFailure ? { ...out, llmFailure } : out;
  }
  // /ask structured segments: the prompt injects <summary>/<analysis>/<suggestions> tags (see pr-agent-bridge
  // prompts.ts); on a hit it produces colored / collapsible findings per segment; if the model does not follow (no paired tags) fall back to the ordinary parsing below.
  if (tool === 'ask') {
    const structured = parseStructuredAsk(stdout);
    if (structured) return llmFailure ? { ...structured, llmFailure } : structured;
  }
  const cleanStdout = stripAnsi(stdout);
  // describe: first extract the File Walkthrough <details> block appended at the end (otherwise it sticks into the ### Diagram
  // Walkthrough segment), making it a standalone "file changes" finding, and convert the nested table into a collapsible unordered list.
  let walkthroughFinding: Finding | undefined;
  let baseMd = cleanStdout;
  if (tool === 'describe') {
    const wt = extractFileWalkthrough(cleanStdout);
    if (wt) {
      baseMd = wt.rest;
      walkthroughFinding = {
        id: 'describe-walkthrough',
        category: 'description',
        sectionKey: 'walkthrough',
        body: walkthroughToList(wt.block),
      };
    }
  }
  // The GFM path is only for /review (under gfm_markdown the whole thing is a <table>); describe/ask still go through markdown
  // slicing (their HTML/table/mermaid is rendered downstream by react-markdown, the section structure is unaffected).
  const gfm = tool === 'review' && isGfmReviewOutput(baseMd);
  const allSections = gfm ? splitGfmTableSections(baseMd) : splitMarkdownSections(baseMd);
  const sections = allSections.filter((s) => !shouldSkipSection(s, tool));
  if (sections.length === 0) {
    const fs = walkthroughFinding ? [walkthroughFinding] : [];
    return llmFailure ? { findings: fs, llmFailure } : { findings: fs };
  }
  // A single section may expand into multiple findings (the key_issues_to_review segment). The cursor idx keeps
  // the global finding numbering stable so the UI list-key does not collide
  const findings: Finding[] = [];
  let idx = 0;
  for (const sec of sections) {
    if (tool === 'review' && isKeyIssuesSection(normalizeTitle(sec.title))) {
      // GFM: sec.body is raw HTML, extract findings by <a href><strong>; non-GFM goes through markdown expansion
      const expanded = gfm
        ? expandGfmKeyIssues(sec.body, idx, tool)
        : expandKeyIssuesSection(sec, idx, tool);
      if (expanded.length === 0) {
        // Nothing extracted (format drift) → fall back to the whole segment as one finding, body cleaned into readable text
        findings.push(
          sectionToFinding(gfm ? { ...sec, body: gfmInlineToText(sec.body) } : sec, idx, tool),
        );
        idx += 1;
      } else {
        findings.push(...expanded);
        idx += expanded.length;
      }
    } else {
      // GFM non-key-issues segment: body is HTML, cleaned into text then handed to sectionToFinding (whose **File:** etc.
      // anchor matching is designed for markdown text; these segments generally have no line-level anchor, so just display after cleaning)
      const s = gfm ? { ...sec, body: gfmInlineToText(sec.body) } : sec;
      findings.push(sectionToFinding(s, idx, tool));
      idx += 1;
    }
  }
  // describe's File Walkthrough as a standalone segment (render order determined by walkthrough in SECTION_ORDER)
  if (walkthroughFinding) findings.push(walkthroughFinding);
  // summary: prefer the first section with a title; if none have a title, take the first line of the first body
  let summary: string | undefined;
  const titled = sections.find((s) => s.title);
  if (titled) summary = normalizeTitle(titled.title);
  else {
    const firstNonEmpty = sections
      .find((s) => s.body)
      ?.body.split('\n')[0]
      ?.trim();
    if (firstNonEmpty) summary = firstNonEmpty;
  }
  // /ask re-review verdict fallback: when structured parsing fails and falls back to this ordinary path, still extract
  // <verdict> from the answer text, not losing the re-review's supersede / closure signal (run-executor's auto-closure depends on it).
  const askVerdict = tool === 'ask' ? extractAskVerdict(cleanStdout) : undefined;
  const base = askVerdict ? { findings, summary, askVerdict } : { findings, summary };
  return llmFailure ? { ...base, llmFailure } : base;
}

/**
 * Parse the output of pr-agent's `/improve` tool.
 *
 * The pr-agent local provider does not implement `publish_code_suggestions`, so `/improve` goes through
 * `publish_comment` writing the aggregated markdown to `review.md` (shared with /review, /ask).
 *
 * The template for each suggestion (from pr-agent `pr_code_suggestions.py`'s generate_summarized_suggestions):
 * ```
 * <details><summary>{one_sentence_summary}</summary>
 *
 * ___
 *
 * **{suggestion_content}**
 *
 * [{relevant_file} [{start}-{end}]]({code_snippet_link})
 *
 * ```diff
 * {patch}
 * ```
 *
 * <details><summary>Suggestion importance[1-10]: {score}</summary>
 *
 * __
 *
 * Why: {score_why}
 *
 * </details>
 *
 * </details>
 * ```
 *
 * Reverse-parse strategy: use the **file marker line** `[<file> [<start>-<end>]](<url>)` as the split point.
 * The range between two adjacent markers is one suggestion; look backward for `<summary>`, and forward for
 * the ` ```diff ` block + `importance[1-10]:` score. Details change across pr-agent versions, so slicing by marker
 * is more robust than hard-parsing the nested HTML.
 *
 * No marker → the output form is unrecognized (old version / config change), returns empty findings + a summary hint.
 */
export function parseImproveOutput(stdout: string): ParsedReviewOutput {
  const cleaned = stripAnsi(stdout).replace(/\r\n/g, '\n');
  const lines = cleaned.split('\n');
  // file marker line: `[<path> [<start>-<end>]](<url>)`, path contains no whitespace (but may contain `[]`, e.g.
  // `a/[m-123]/x.ts`); range may be `[42-45]` or `[42]` (single line). path uses a lazy non-whitespace `[^\s]+?` +
  // the mandatory ` [<range>]](` suffix to delimit, so the `]` in the path is no longer wrongly cut.
  const markerRe = /^\[([^\s]+?)\s+\[(\d+)(?:-(\d+))?\]\]\(/;
  interface Marker {
    idx: number;
    file: string;
    startLine: number;
    endLine: number;
  }
  const markers: Marker[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = markerRe.exec(lines[i]!.trim());
    if (m) {
      const startLine = Number.parseInt(m[2]!, 10);
      const endLine = m[3] ? Number.parseInt(m[3], 10) : startLine;
      markers.push({ idx: i, file: m[1]!, startLine, endLine });
    }
  }
  if (markers.length === 0) {
    return {
      findings: [],
      summary: '未识别到改进建议（pr-agent 输出格式可能变化）',
    };
  }
  const findings: Finding[] = [];
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i]!;
    const nextIdx = i + 1 < markers.length ? markers[i + 1]!.idx : lines.length;
    const prevIdx = i > 0 ? markers[i - 1]!.idx : 0;
    const blockText = lines.slice(m.idx, nextIdx).join('\n');

    // suggestion_content: the nearest non-empty non-HTML line above the marker (usually **...** bold)
    let content = '';
    for (let j = m.idx - 1; j > prevIdx; j--) {
      const l = lines[j]!.trim();
      if (!l) continue;
      if (l.startsWith('<') || l === '___' || l === '__') continue;
      content = l.replace(/^\*\*\s*|\s*\*\*$/g, '').trim();
      break;
    }

    // one_sentence_summary: the nearest <summary>...</summary> above the marker (not the importance one)
    let summaryText = '';
    for (let j = m.idx - 1; j > prevIdx; j--) {
      const sm = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(lines[j]!);
      if (sm && !/importance/i.test(sm[1]!)) {
        summaryText = sm[1]!.replace(/<[^>]+>/g, ' ').trim();
        break;
      }
    }

    // diff block + split -/+ lines
    let codeChange: FindingCodeChange | undefined;
    const diffStart = blockText.indexOf('```diff');
    if (diffStart >= 0) {
      const after = blockText.slice(diffStart + '```diff'.length);
      const diffEnd = after.indexOf('```');
      if (diffEnd >= 0) {
        const patch = after.slice(0, diffEnd).replace(/^\n+|\n+$/g, '');
        const existingLines: string[] = [];
        const improvedLines: string[] = [];
        for (const dl of patch.split('\n')) {
          if (dl.startsWith('-')) existingLines.push(dl.slice(1).replace(/^ /, ''));
          else if (dl.startsWith('+')) improvedLines.push(dl.slice(1).replace(/^ /, ''));
          // Plain context lines (leading space) are rare in pr-agent improve diffs, ignored
        }
        if (existingLines.length > 0 || improvedLines.length > 0) {
          codeChange = {
            existing: existingLines.join('\n'),
            improved: improvedLines.join('\n'),
          };
        }
      }
    }

    // score
    const scoreM = /importance\[1-10\]:\s*(\d+)/i.exec(blockText);
    const score = scoreM ? Number.parseInt(scoreM[1]!, 10) : undefined;

    findings.push({
      id: `improve-${String(i).padStart(3, '0')}`,
      category: 'code-feedback',
      sectionKey: 'code-suggestion',
      title: summaryText || content || '改进建议',
      body: content,
      anchor: { path: m.file, startLine: m.startLine, endLine: m.endLine },
      codeChange,
      score,
    });
  }
  return {
    findings,
    summary: `${String(findings.length)} 条改进建议`,
  };
}

function stripBackticks(s: string): string {
  return s.replace(/^`|`$/g, '');
}
