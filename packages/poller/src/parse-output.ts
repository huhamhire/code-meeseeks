import type {
  Finding,
  FindingAnchor,
  FindingCodeChange,
  PrDocSectionKey,
  ReviewRunTool,
} from '@pr-pilot/shared';

export interface ParsedReviewOutput {
  /** 取首个非空 section 标题 / 描述首行作为 PR 摘要 */
  summary?: string;
  findings: Finding[];
}

/**
 * 剥掉文本里的 ANSI 转义码。pr-agent 在容器里跑时 stdout 也带颜色 (logger 配置使然)，
 * 解析 / 落到 finding body / 走 react-markdown 渲染都不该带 `\x1b[...m`。
 * 实时流走 ChatPane 的 AnsiPre 解析，那条路径保留 ANSI；这里只处理"持久化 / 解析"。
 *
 * 同时剥 CSI (`ESC [ ... letter`) 和 OSC (`ESC ] ... BEL/ST`) 等常见控制序列。
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b\[[\d;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, '');
}

interface Section {
  /** Markdown header 级别 1-6 */
  level: number;
  title: string;
  body: string;
}

/**
 * 把 pr-agent 0.35.0 的 markdown 输出按 H1-H6 切片为 sections。
 * 每个 section 含 level / title / body（body 去掉前后空白）。
 * 顶部无 header 的前导内容也合成一个 level=0 / title='' 的 section，便于 /describe
 * 整段拿出来。
 */
export function splitMarkdownSections(md: string): Section[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const sections: Section[] = [];
  let cur: Section | null = { level: 0, title: '', body: '' };
  const HEADER_RE = /^(#{1,6})\s+(.+?)\s*$/;
  for (const line of lines) {
    const m = HEADER_RE.exec(line);
    if (m) {
      // 先把 prev section 收尾（去掉空段）
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

/** 剥 markdown 强调符号 (`**Foo**` → `Foo`)，用作 title 显示 + 归一比对 */
function normalizeTitle(t: string): string {
  return t.replace(/[*_]+/g, '').trim();
}

/** 我们 materializeWorktree 临时建的内部分支名，pr-agent 把它当 PR 标识漏出来 */
const INTERNAL_BRANCH_RE = /pr-pilot\/(head|base)/i;

/**
 * 剥 body 首尾的"噪音行"：连续 markdown HR (`---` / `***` / `___`)、空行、
 * 整行就是 `pr-pilot/head|base` 的内部分支名 leak。pr-agent 在段落间用 `---`
 * 分隔，splitMarkdownSections 切完后这条 HR 会黏在上一个 section 的 body 末尾；
 * 类似地 pr-pilot/head 这种 PR identifier leak 也可能停在 body 首或尾。
 * 全部在 parser 层清掉，下游 / 渲染 / 胶囊拆分都不用关心。
 */
function trimNoise(body: string): string {
  const isNoise = (l: string): boolean => {
    const trimmed = l.trim();
    if (trimmed === '') return true;
    if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) return true; // markdown HR
    if (INTERNAL_BRANCH_RE.test(trimmed) && trimmed.length < 40) return true; // 短行 + 含分支名
    return false;
  };
  const lines = body.split('\n');
  while (lines.length > 0 && isNoise(lines[0]!)) lines.shift();
  while (lines.length > 0 && isNoise(lines[lines.length - 1]!)) lines.pop();
  return lines.join('\n');
}

/**
 * 把规整化后的 title 映射到稳定 sectionKey。匹配采用 lower-case + 正则，覆盖
 * pr-agent 不同版本 / /describe vs /review / 中英变体的常见拼写。
 *
 * 维护时新增 key：在 PrDocSectionKey 类型加，在此表加一条 [regex, key]。
 */
const SECTION_KEY_PATTERNS: ReadonlyArray<readonly [RegExp, PrDocSectionKey]> = [
  [/^(?:suggested[\s_-]+)?title$/i, 'title'],
  [/^pr[\s_-]*type$/i, 'pr-type'],
  [/^type$/i, 'pr-type'],
  [/^(?:pr[\s_-]+reviewer[\s_-]+guide|review[\s_-]+summary|summary)$/i, 'summary'],
  [/^description$/i, 'description'],
  [/^walkthrough$/i, 'walkthrough'],
  [/^relevant[\s_-]+tests?$/i, 'relevant-tests'],
  [/^security(?:[\s_-]+concerns?)?$/i, 'security'],
  [/^estimated[\s_-]+effort.*$/i, 'effort'],
  [/^(?:code[\s_-]+quality[\s_-]+)?score$/i, 'score'],
];

function mapSectionKey(displayTitle: string): PrDocSectionKey | undefined {
  // 剥首尾的 emoji / 标点 / 空白，让 `⏱️ Estimated effort to review: 3 🔵🔵`
  // 这种带装饰的标题也能命中 SECTION_KEY_PATTERNS 里的英文锚词
  const cleaned = displayTitle.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim();
  for (const [re, key] of SECTION_KEY_PATTERNS) {
    if (re.test(cleaned)) return key;
  }
  return undefined;
}

/**
 * 噪音段落，直接从 findings 里剔除：
 * - `user description`：纯粹回显用户已写的 PR 描述，UI 上已有 PrInfoView 显示
 * - title 含 `pr-pilot/head|base`：我们临时建的分支名，pr-agent 把它当 PR 标识
 *   作为各级 heading leak 出来（含 emoji / 修饰也照样匹配，子串就行）
 * - 空 title + 经 trimNoise 后空 body：纯分支名 leak 的独立 section
 * - /ask 工具下的 `question` / `questions` 段：UI 上方 chat-user-msg 已展示用户提问，
 *   pr-agent 把问题回显在答案文本里是冗余的
 */
const SKIP_TITLES = new Set(['user description']);
const SKIP_TITLES_ASK = new Set(['question', 'questions', '问题']);

function shouldSkipSection(sec: Section, tool: ReviewRunTool): boolean {
  const t = normalizeTitle(sec.title).toLowerCase();
  if (SKIP_TITLES.has(t)) return true;
  if (tool === 'ask' && SKIP_TITLES_ASK.has(t)) return true;
  // title 含内部分支名 (e.g., "pr-pilot/head" / "pr-pilot/head 🔍" / "## pr-pilot/head")
  if (INTERNAL_BRANCH_RE.test(t)) return true;
  // trimNoise 把首尾的 HR / 分支名 leak 剥掉后，body 空 = 整段都是噪音
  const cleanedBody = trimNoise(sec.body).trim();
  if (!t && !cleanedBody) return true;
  return false;
}

/**
 * 解析单段 markdown 为 Finding。识别 pr-agent 常见的
 * `**File:** path` + `**Lines:** N-M` 模式 → code-feedback；其它返回 general / description。
 */
export function sectionToFinding(sec: Section, index: number, tool: ReviewRunTool): Finding {
  const id = `${tool}-${String(index).padStart(3, '0')}`;
  const body = trimNoise(sec.body);
  const displayTitle = normalizeTitle(sec.title) || undefined;
  const mappedKey = displayTitle ? mapSectionKey(displayTitle) : undefined;

  // pr-agent 0.35.0 review 输出形如：
  //   **File:** src/foo.ts
  //   **Lines:** 42-50
  //   **Issue:** ...
  // 兼容 file_path / Line / 行号 等中英变体
  const fileMatch =
    /^\s*\*\*\s*(?:file(?:[_\s]?path)?|路径|文件)\s*:?\s*\*\*\s*(.+?)\s*$/im.exec(body);
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

  return {
    id,
    category: tool === 'describe' ? 'description' : 'general',
    sectionKey: mappedKey ?? 'general',
    title: displayTitle,
    body,
  };
}

/**
 * 解析 pr-agent stdout 为 findings 列表。M3-B2 是 best-effort：
 * - 切 markdown sections
 * - 跳过噪音段落 (临时分支名 leak / 用户描述回显)
 * - 识别 file + lines 模式标 code-feedback
 * - 已知 section title 映射到 sectionKey，UI 用于排序 / 着色
 *
 * /improve 走专门解析路径：pr-agent local provider 输出是 HTML <details> 嵌套结构
 * 而非纯 markdown sections，splitMarkdownSections 切不出来。
 *
 * 失败 / 空输出 / 完全不规则的格式 → findings 为空数组，调用方可以回退到展示原始
 * stdout。不在这里抛错。
 */
export function parseReviewOutput(stdout: string, tool: ReviewRunTool): ParsedReviewOutput {
  if (tool === 'improve') return parseImproveOutput(stdout);
  const allSections = splitMarkdownSections(stripAnsi(stdout));
  const sections = allSections.filter((s) => !shouldSkipSection(s, tool));
  if (sections.length === 0) return { findings: [] };
  const findings: Finding[] = sections.map((s, i) => sectionToFinding(s, i, tool));
  // summary：优先取首个有 title 的 section；都没有 title 取首个 body 首行
  let summary: string | undefined;
  const titled = sections.find((s) => s.title);
  if (titled) summary = normalizeTitle(titled.title);
  else {
    const firstNonEmpty = sections.find((s) => s.body)?.body.split('\n')[0]?.trim();
    if (firstNonEmpty) summary = firstNonEmpty;
  }
  return { findings, summary };
}

/**
 * 解析 pr-agent `/improve` 工具的输出。
 *
 * pr-agent local provider 不实现 `publish_code_suggestions`，所以 `/improve` 走
 * `publish_comment` 把汇总 markdown 写到 `review.md` (跟 /review、/ask 共用)。
 *
 * 每条建议的模板 (摘自 pr-agent `pr_code_suggestions.py` 的 generate_summarized_suggestions)：
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
 * 反解策略：以**file marker 行** `[<file> [<start>-<end>]](<url>)` 为切分点。
 * 每两个相邻 marker 之间是一条建议的范围，向前找 `<summary>`，向后找
 * ` ```diff ` 块 + `importance[1-10]:` 评分。pr-agent 版本间细节会变，按 marker
 * 切片比硬解 HTML 嵌套更稳。
 *
 * 没有 marker → 输出形态不识别（旧版 / 配置变化），返回空 findings + summary 提示。
 */
export function parseImproveOutput(stdout: string): ParsedReviewOutput {
  const cleaned = stripAnsi(stdout).replace(/\r\n/g, '\n');
  const lines = cleaned.split('\n');
  // file marker 行：`[<path> [<start>-<end>]](<url>)`，path 内不含 `]` / 空白；
  // range 可能 `[42-45]` 或 `[42]` (单行)
  const markerRe =
    /^\[([^\]\s]+)\s+\[(\d+)(?:-(\d+))?\]\]\(/;
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

    // suggestion_content: marker 上面最近的非空非 HTML 行 (通常 **...** 加粗)
    let content = '';
    for (let j = m.idx - 1; j > prevIdx; j--) {
      const l = lines[j]!.trim();
      if (!l) continue;
      if (l.startsWith('<') || l === '___' || l === '__') continue;
      content = l.replace(/^\*\*\s*|\s*\*\*$/g, '').trim();
      break;
    }

    // one_sentence_summary: marker 上面最近的 <summary>...</summary> (不含 importance 那个)
    let summaryText = '';
    for (let j = m.idx - 1; j > prevIdx; j--) {
      const sm = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(lines[j]!);
      if (sm && !/importance/i.test(sm[1]!)) {
        summaryText = sm[1]!.replace(/<[^>]+>/g, ' ').trim();
        break;
      }
    }

    // diff block + 拆 -/+ 行
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
          // 普通 context 行 (空格起手) 在 pr-agent improve diff 里少见，忽略
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
