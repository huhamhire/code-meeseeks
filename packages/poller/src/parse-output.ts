import type { Finding, FindingAnchor, ReviewRunTool } from '@pr-pilot/shared';

export interface ParsedReviewOutput {
  /** 取首个非空 section 标题 / 描述首行作为 PR 摘要 */
  summary?: string;
  findings: Finding[];
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

/**
 * 解析单段 markdown 为 Finding。识别 pr-agent 常见的
 * `**File:** path` + `**Lines:** N-M` 模式 → code-feedback；其它返回 general / description。
 */
export function sectionToFinding(sec: Section, index: number, tool: ReviewRunTool): Finding {
  const id = `${tool}-${String(index).padStart(3, '0')}`;
  const body = sec.body;
  const title = sec.title || undefined;

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
    return { id, category: 'code-feedback', title, body, anchor };
  }

  return {
    id,
    category: tool === 'describe' ? 'description' : 'general',
    title,
    body,
  };
}

/**
 * 解析 pr-agent stdout 为 findings 列表。M3-B2 是 best-effort：
 * - 切 markdown sections
 * - 识别 file + lines 模式标 code-feedback
 * - 其它落 general / description
 *
 * 失败 / 空输出 / 完全不规则的格式 → findings 为空数组，调用方可以回退到展示原始
 * stdout。不在这里抛错。
 */
export function parseReviewOutput(stdout: string, tool: ReviewRunTool): ParsedReviewOutput {
  const sections = splitMarkdownSections(stdout);
  if (sections.length === 0) return { findings: [] };
  const findings: Finding[] = sections.map((s, i) => sectionToFinding(s, i, tool));
  // summary：优先取首个有 title 的 section；都没有 title 取首个 body 首行
  let summary: string | undefined;
  const titled = sections.find((s) => s.title);
  if (titled) summary = titled.title;
  else {
    const firstNonEmpty = sections.find((s) => s.body)?.body.split('\n')[0]?.trim();
    if (firstNonEmpty) summary = firstNonEmpty;
  }
  return { findings, summary };
}

function stripBackticks(s: string): string {
  return s.replace(/^`|`$/g, '');
}
