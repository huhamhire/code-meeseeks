import type { Finding, FindingAnchor, PrDocSectionKey, ReviewRunTool } from '@pr-pilot/shared';

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
  for (const [re, key] of SECTION_KEY_PATTERNS) {
    if (re.test(displayTitle)) return key;
  }
  return undefined;
}

/**
 * 噪音段落，直接从 findings 里剔除：
 * - `pr-pilot/head` / `pr-pilot/base`：我们 materializeWorktree 临时建的分支名，
 *   pr-agent 以为是 PR 标识，常作为顶层 h1 leak 出来
 * - `user description`：纯粹回显用户已写的 PR 描述，UI 上已有 PrInfoView 显示
 * - 空 title + 空 body
 */
const SKIP_TITLES = new Set([
  'pr-pilot/head',
  'pr-pilot/base',
  'user description',
]);

function shouldSkipSection(sec: Section): boolean {
  const t = normalizeTitle(sec.title).toLowerCase();
  if (SKIP_TITLES.has(t)) return true;
  if (!t && !sec.body.trim()) return true;
  return false;
}

/**
 * 解析单段 markdown 为 Finding。识别 pr-agent 常见的
 * `**File:** path` + `**Lines:** N-M` 模式 → code-feedback；其它返回 general / description。
 */
export function sectionToFinding(sec: Section, index: number, tool: ReviewRunTool): Finding {
  const id = `${tool}-${String(index).padStart(3, '0')}`;
  const body = sec.body;
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
 * 失败 / 空输出 / 完全不规则的格式 → findings 为空数组，调用方可以回退到展示原始
 * stdout。不在这里抛错。
 */
export function parseReviewOutput(stdout: string, tool: ReviewRunTool): ParsedReviewOutput {
  const allSections = splitMarkdownSections(stripAnsi(stdout));
  const sections = allSections.filter((s) => !shouldSkipSection(s));
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

function stripBackticks(s: string): string {
  return s.replace(/^`|`$/g, '');
}
